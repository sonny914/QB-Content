#!/usr/bin/env python3
"""Download the untouched source clip for the AI automation reel."""
from pathlib import Path
import hashlib
import urllib.request

URL = "https://d2ol7oe51mr4n9.cloudfront.net/user_3JmSJylII1Rwwc3uXrm5CkcuSQk/46969028-032b-477e-b7af-d65e9ee0912e.mp4"
SHA256 = "e8c4d38768c29ba6c7b7c70b9358c2b39adb7983d1ac9571bc02497f64f409e8"
TARGET = Path(__file__).resolve().parent / "original.mp4"

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

if TARGET.exists():
    if digest(TARGET) != SHA256:
        raise SystemExit("Existing original.mp4 differs; refusing to overwrite it.")
    print(f"Verified original: {TARGET}")
else:
    temporary = TARGET.with_suffix(".download")
    urllib.request.urlretrieve(URL, temporary)
    if digest(temporary) != SHA256:
        temporary.unlink()
        raise SystemExit("Checksum mismatch; source was not saved.")
    temporary.replace(TARGET)
    print(f"Downloaded and verified: {TARGET}")
