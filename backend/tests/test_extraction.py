from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import signup_and_verify
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from pydantic import SecretStr, ValidationError
from sqlalchemy import select

from app.config import Settings
from app.extraction import extract_events_with_claude
from app.image_uploads import MAX_IMAGE_BYTES, InvalidImage, decode_and_reencode
from app.models import Upload
from app.schemas import ExtractedEvent


def create_png(with_private_metadata: bool = False) -> bytes:
    image = Image.new("RGB", (32, 24), color=(20, 40, 60))
    output = BytesIO()
    if with_private_metadata:
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("private", "metadata that should be removed")
        image.save(output, format="PNG", pnginfo=metadata)
    else:
        image.save(output, format="PNG")
    return output.getvalue()


def logged_in(client: TestClient) -> str:
    csrf_token = signup_and_verify(client, "image-owner@example.com")
    response = client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": "image-owner@example.com", "password": "Secure$Passphrase456"},
    )
    assert response.status_code == 200
    return csrf_token


def test_image_magic_validation_and_metadata_stripping() -> None:
    original = create_png(with_private_metadata=True)
    cleaned, media_type, extension = decode_and_reencode(original)
    assert media_type == "image/png"
    assert extension == ".png"
    with Image.open(BytesIO(cleaned)) as image:
        assert image.info == {}
    with pytest.raises(InvalidImage):
        decode_and_reencode(b"this is not an image")
    with pytest.raises(InvalidImage):
        decode_and_reencode(b"x" * (MAX_IMAGE_BYTES + 1))


def test_extract_falls_back_and_retains_only_on_explicit_opt_in(client: TestClient) -> None:
    csrf_token = logged_in(client)
    original = create_png(with_private_metadata=True)
    response = client.post(
        "/events/extract",
        headers={"X-CSRF-Token": csrf_token},
        data={"keep_original": "true"},
        files={"file": ("untrusted.txt", original, "text/plain")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["events"] == []
    assert body["manual_entry_suggested"] is True
    assert body["retained_upload_id"]

    with client.app.state.session_factory() as db:
        upload = db.scalar(select(Upload))
        assert upload is not None
        path = Path(client.app.state.settings.upload_dir) / upload.storage_key
        assert path.is_file()
        with Image.open(path) as image:
            assert image.info == {}

    response = client.get(f"/uploads/{body['retained_upload_id']}")
    assert response.status_code == 200
    other = TestClient(client.app, base_url="http://testserver")
    try:
        csrf_b = signup_and_verify(other, "another-user@example.com")
        login = other.post(
            "/auth/login",
            headers={"X-CSRF-Token": csrf_b},
            json={
                "email": "another-user@example.com",
                "password": "Secure$Passphrase456",
            },
        )
        assert login.status_code == 200
        assert other.get(f"/uploads/{body['retained_upload_id']}").status_code == 404
        assert other.get("/export/json").json()["uploads"] == []
    finally:
        other.close()
    response = client.delete("/me", headers={"X-CSRF-Token": csrf_token})
    assert response.status_code == 204
    assert not path.exists()


def test_extract_rejects_fake_and_oversized_files(client: TestClient) -> None:
    csrf_token = logged_in(client)
    for contents in (b"not an image", b"x" * (MAX_IMAGE_BYTES + 1)):
        response = client.post(
            "/events/extract",
            headers={"X-CSRF-Token": csrf_token},
            files={"file": ("image.png", contents, "image/png")},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "invalid_image"


def test_extraction_output_is_strictly_validated() -> None:
    valid = ExtractedEvent(
        title="Concert",
        date="2030-07-14",
        time="19:30",
        end_time="22:00",
        location="Hall",
        confidence=0.93,
        notes=None,
    )
    assert valid.confidence == 0.93
    with pytest.raises(ValidationError):
        ExtractedEvent(
            title="Concert",
            date="2030-02-31",
            time="25:90",
            confidence=1.1,
        )


def test_claude_response_retries_and_receives_local_time(monkeypatch) -> None:
    calls = []

    class FakeMessages:
        def create(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                tool_input = {"events": [{"title": "Malformed"}]}
            else:
                tool_input = {
                    "events": [
                        {
                            "title": "Dinner",
                            "date": "2030-07-09",
                            "time": "20:45",
                            "end_time": None,
                            "location": "Cafe",
                            "confidence": 0.88,
                            "notes": None,
                        }
                    ]
                }
            return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=tool_input)])

    monkeypatch.setattr(
        "app.extraction.Anthropic",
        lambda api_key: SimpleNamespace(messages=FakeMessages()),
    )
    settings = Settings(
        app_env="test",
        database_url="sqlite:///:memory:",
        app_secret=SecretStr("J3p!0OklYdgPq1wXc9ZtHVrF8AbEsu2LmN4Qw6Ty"),
        anthropic_api_key=SecretStr("test-api-key"),
    )
    events = extract_events_with_claude(
        b"validated image bytes",
        "image/png",
        "America/New_York",
        settings,
        now=datetime(2030, 7, 10, 0, 30, tzinfo=UTC),
    )
    assert len(events) == 1
    assert events[0].title == "Dinner"
    assert len(calls) == 2
    prompt = calls[0]["messages"][0]["content"][1]["text"]
    assert "2030-07-09T20:30:00-04:00" in prompt
    assert "America/New_York" in prompt
