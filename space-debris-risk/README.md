# Space Debris Risk (Hackathon Scaffold)

This repo is a monorepo scaffold for a space debris exposure risk dashboard.

## Structure
- `backend/` — FastAPI API that returns risk score + explanations (rule-based MVP)
- `frontend/` — Next.js dashboard (form + charts + 3D placeholder)

## Quick start (local)

### Backend
```bash
cd space-debris-risk/backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
