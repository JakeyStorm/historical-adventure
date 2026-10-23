from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
names = ["package.json", "server.mjs", "generation.mjs", "story.mjs", "Dockerfile",
         "compose.yaml", "Caddyfile", "Caddyfile.ip", ".dockerignore", ".env.example",
         ".gitignore", "README.md"]
files = [root / name for name in names]
files += [p for p in (root / "dist").rglob("*") if p.is_file()]
files += list((root / "tests").glob("*.test.mjs"))
files += [root / "scripts" / "check-polza.mjs", root / "scripts" / "package-release.py"]

secrets = []
for path in [root / ".env", root / "data" / "deployment" / ".env.server", root / "data" / "Доступ к серверу REG.RU.md"]:
    if not path.exists():
        continue
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if key.strip() in {"POLZA_API_KEY", "GENERATION_PASSWORD", "SSH_PASSWORD"} and len(value) >= 8:
            secrets.append(value.encode())

target = root.parent / "A-Historical-adventure.zip"
temporary = target.with_suffix(".zip.tmp")
with ZipFile(temporary, "w", ZIP_DEFLATED) as archive:
    for path in files:
        payload = path.read_bytes()
        if any(secret in payload for secret in secrets):
            raise SystemExit("Secret found; release stopped.")
        archive.writestr("A-Historical-adventure/" + path.relative_to(root).as_posix(), payload)
    for name in ["АДРЕС САЙТА.txt", "СЦЕНАРИЙ ПОКАЗА САЙТА.txt"]:
        document=root.parent/name
        if not document.exists():
            continue
        payload = document.read_bytes()
        if any(secret in payload for secret in secrets):
            raise SystemExit("Secret found; release stopped.")
        archive.writestr("A-Historical-adventure/" + name, payload)
with ZipFile(temporary) as archive:
    assert archive.testzip() is None
    assert not any("/data/" in name or name.endswith("/.env") for name in archive.namelist())
    count = len(archive.namelist())
temporary.replace(target)
print(f"Release updated: {count} files, {target.stat().st_size} bytes; credentials excluded and checked.")
