import os
import warnings
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Upload

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
FORMATS = {
    "JPEG": ("image/jpeg", ".jpg"),
    "PNG": ("image/png", ".png"),
    "WEBP": ("image/webp", ".webp"),
}


class InvalidImage(ValueError):
    pass


def decode_and_reencode(raw_image: bytes) -> tuple[bytes, str, str]:
    if not raw_image or len(raw_image) > MAX_IMAGE_BYTES:
        raise InvalidImage("Upload must be between 1 byte and 5 MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            source = Image.open(BytesIO(raw_image))
            image_format = source.format
            if image_format not in FORMATS:
                raise InvalidImage("Only JPEG, PNG, and WebP images are supported.")
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise InvalidImage("Image dimensions are too large.")
            source.verify()
            source = Image.open(BytesIO(raw_image))
            source.load()
            clean = ImageOps.exif_transpose(source)
            if image_format == "JPEG":
                clean = clean.convert("RGB")
            elif "A" in clean.getbands():
                clean = clean.convert("RGBA")
            else:
                clean = clean.convert("RGB")
            output = BytesIO()
            clean.save(output, format=image_format, optimize=True, exif=b"")
    except InvalidImage:
        raise
    except (OSError, ValueError, Image.DecompressionBombError, UnidentifiedImageError) as error:
        raise InvalidImage("The uploaded file is not a valid supported image.") from error
    processed = output.getvalue()
    if len(processed) > MAX_IMAGE_BYTES:
        raise InvalidImage("Processed image exceeds the 5 MB limit.")
    media_type, extension = FORMATS[image_format]
    return processed, media_type, extension


def store_private_upload(
    settings: Settings,
    db: Session,
    user_id: UUID,
    image: bytes,
    media_type: str,
    extension: str,
) -> Upload:
    root = Path(settings.upload_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        root.chmod(0o700)
    storage_key = f"{uuid4().hex}{extension}"
    target = (root / storage_key).resolve()
    if target.parent != root:
        raise RuntimeError("Upload storage path escaped its private directory.")
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(image)
    upload = Upload(
        user_id=user_id,
        storage_key=storage_key,
        media_type=media_type,
    )
    db.add(upload)
    db.flush()
    return upload


def remove_private_upload(settings: Settings, storage_key: str) -> None:
    root = Path(settings.upload_dir).resolve()
    target = (root / storage_key).resolve()
    if target.parent != root:
        raise RuntimeError("Upload storage path escaped its private directory.")
    target.unlink(missing_ok=True)


def uploads_for_user(db: Session, user_id: UUID) -> list[Upload]:
    return list(db.scalars(select(Upload).where(Upload.user_id == user_id)))
