import os
import tempfile
from pathlib import Path

os.environ["FRAMING_LAB_DATA"] = tempfile.mkdtemp(prefix="framing-lab-")
os.environ.pop("OPENAI_API_KEY", None)
Path(os.environ["FRAMING_LAB_DATA"]).mkdir(parents=True, exist_ok=True)
