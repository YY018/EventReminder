import json
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from conftest import signup_and_verify
from fastapi.testclient import TestClient

from app.events import local_day_utc_bounds


def create_logged_in_user(client: TestClient, email: str) -> str:
    csrf_token = signup_and_verify(client, email)
    response = client.post(
        "/auth/login",
        headers={"X-CSRF-Token": csrf_token},
        json={"email": email, "password": "Secure$Passphrase456"},
    )
    assert response.status_code == 200
    return csrf_token


def test_event_crud_duplicate_check_and_reminders(client: TestClient) -> None:
    csrf_token = create_logged_in_user(client, "owner@example.com")
    start = (datetime.now(UTC) + timedelta(days=4)).replace(second=0, microsecond=0)
    payload = {
        "events": [
            {
                "title": "Design review",
                "start_at": start.isoformat(),
                "end_at": (start + timedelta(hours=1)).isoformat(),
                "location": "Room 12",
                "notes": "Bring a prototype",
            }
        ]
    }
    response = client.post(
        "/events",
        headers={"X-CSRF-Token": csrf_token},
        json=payload,
    )
    assert response.status_code == 201
    event = response.json()[0]
    assert event["start_utc"].endswith("Z")
    event_id = event["id"]
    assert len(client.get("/reminders").json()) == 3

    response = client.post(
        "/events",
        headers={"X-CSRF-Token": csrf_token},
        json=payload,
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "duplicate_events"
    payload["confirm_duplicates"] = True
    response = client.post(
        "/events",
        headers={"X-CSRF-Token": csrf_token},
        json=payload,
    )
    assert response.status_code == 201

    response = client.get("/events?q=prototype")
    assert len(response.json()) == 2
    response = client.patch(
        f"/events/{event_id}",
        headers={"X-CSRF-Token": csrf_token},
        json={"status": "done"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "done"

    response = client.delete(
        f"/events/{event_id}",
        headers={"X-CSRF-Token": csrf_token},
    )
    assert response.status_code == 204
    response = client.get(f"/events/{event_id}")
    assert response.status_code == 404


def test_cross_account_event_and_export_isolation(client: TestClient) -> None:
    csrf_a = create_logged_in_user(client, "owner@example.com")
    start = (datetime.now(UTC) + timedelta(days=2)).replace(second=0, microsecond=0)
    response = client.post(
        "/events",
        headers={"X-CSRF-Token": csrf_a},
        json={
            "events": [
                {
                    "title": "Private event",
                    "start_at": start.isoformat(),
                    "location": "Confidential venue",
                }
            ]
        },
    )
    event_id = response.json()[0]["id"]

    other = TestClient(client.app, base_url="http://testserver")
    try:
        csrf_b = create_logged_in_user(other, "other@example.com")
        assert other.get("/events").json() == []
        assert other.get(f"/events/{event_id}").status_code == 404
        assert (
            other.patch(
                f"/events/{event_id}",
                headers={"X-CSRF-Token": csrf_b},
                json={"title": "Taken over"},
            ).status_code
            == 404
        )
        assert (
            other.delete(
                f"/events/{event_id}",
                headers={"X-CSRF-Token": csrf_b},
            ).status_code
            == 404
        )
        assert other.get("/reminders").json() == []
        exported = other.get("/export/json")
        assert exported.status_code == 200
        assert json.loads(exported.text)["events"] == []
        assert other.get("/export/ics").status_code == 200
        assert "Private event" not in other.get("/export/ics").text
    finally:
        other.close()


def test_event_rejects_timezone_naive_datetimes(client: TestClient) -> None:
    csrf_token = create_logged_in_user(client, "owner@example.com")
    response = client.post(
        "/events",
        headers={"X-CSRF-Token": csrf_token},
        json={"events": [{"title": "No timezone", "start_at": "2030-01-01T10:00:00"}]},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_local_day_bounds_respect_dst_transitions() -> None:
    timezone = ZoneInfo("America/New_York")
    spring_start, spring_end = local_day_utc_bounds(date(2026, 3, 8), timezone)
    fall_start, fall_end = local_day_utc_bounds(date(2026, 11, 1), timezone)
    assert spring_end - spring_start == timedelta(hours=23)
    assert fall_end - fall_start == timedelta(hours=25)
