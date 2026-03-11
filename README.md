# Fat Loss Nutrition Calculator (Local iOS Deployment)

This is an offline-first local Web App (PWA) with:

1. Fixed daily goals: set once and reuse every day (editable anytime)
2. Custom nutrients: freely add nutrients (for example, Vitamin D)
3. Two intake logging methods:
   - OCR from nutrition labels (photo/upload)
   - Direct manual nutrient entry
4. Reusable food templates integrated with daily intake logging:
   - Default flow is Method A: log by food
   - Choosing `+ Add New Food` opens a modal (manual or OCR)
   - If no foods exist, the modal opens automatically
   - After saving, you return to Method A to continue logging
5. Built-in food search in Method A:
   - Search existing foods by name keywords
6. Two planning modes:
   - Algorithm-based combinations from saved foods
   - Optional LLM API planning (provide your token)

## Run Locally

```bash
cd "/path/to/fatloss-calculator"
python3 -m http.server 5173
```

Open in browser:

- On this Mac: `http://localhost:5173`
- On iPhone (same Wi-Fi): `http://<your-lan-ip>:5173`

In Safari on iPhone: Share -> Add to Home Screen.

## Data & Storage

- All data is stored in browser `localStorage`
- No external database required
- Offline by default via service worker cache

## Notes

- OCR uses `tesseract.js`; always review and correct parsed values
- LLM call uses OpenAI-compatible endpoint: `{endpoint}/v1/chat/completions`
- API token is stored only in local browser storage (keep your device secure)
