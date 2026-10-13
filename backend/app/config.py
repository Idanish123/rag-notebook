import os
from pathlib import Path


def load_dotenv():
	env_file = Path(__file__).resolve().parents[1] / ".env"
	if not env_file.is_file():
		return
	for line in env_file.read_text(encoding="utf-8").splitlines():
		line = line.strip()
		if not line or line.startswith("#") or "=" not in line:
			continue
		key, value = line.split("=", 1)
		os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv()
_backend = Path(__file__).resolve().parents[1]
DATA = Path(os.getenv("DATA_DIR", "data"))
if not DATA.is_absolute():
    DATA = _backend / DATA
DATA.mkdir(parents=True, exist_ok=True)
(DATA / "uploads").mkdir(exist_ok=True)

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
EMBED_MODEL = os.getenv("EMBED_MODEL", "models/gemini-embedding-001")
EMBED_DIM = int(os.getenv("EMBED_DIM", "768"))
QDRANT_URL = os.getenv("QDRANT_URL", "")
COLLECTION = "notebook"
