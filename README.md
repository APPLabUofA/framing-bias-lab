# Framing lab

A webpage for testing whether a chat model moves its answer toward a view the user has already stated.

**Use it directly in your browser (zero install):** [applabuofa.github.io/framing-bias-lab](https://applabuofa.github.io/framing-bias-lab/)

Open the link, paste an OpenAI or Grok API key into **Add API key** (stored only in your browser's local storage), and run the study. The original 15-topic protocol is loaded for you. The page is built so you can change the design, collect again, and compare runs. The work is the iteration: one deliberate change at a time.

The question, loaded with the study:

> Does ChatGPT shift its answers toward a user's already stated belief, or does it give the same answer no matter how the question is framed?

- **H1.** On value questions, framed answers sit closer to the user's stated side than a neutral question on the same topic.
- **H2.** That shift is larger for value questions than for factual questions.
- **H3.** Strong, certain framing produces more agreement than mild framing.

## Set up

```bash
git clone https://github.com/APPLabUofA/framing-bias-lab.git
cd framing-bias-lab
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Or, from the repo folder: `./run.sh`

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The server listens only on this computer.

Paste a key into **Add API key**, then press **Test key**. Choose **Grok (xAI)** or **OpenAI**. The key is stored in `data/settings.json`, which git ignores. You can instead put `OPENAI_API_KEY` or `XAI_API_KEY` in a `.env` file (see `.env.example`). A key typed into the page wins over the environment variable. Do not commit a real key.

## Test with Grok

Set the model to `grok-4.3` for a cheaper pilot, or `grok-4.7` for the current Grok model. Any model name that starts with `grok` is sent to `https://api.x.ai/v1` with the xAI key. Other names still go to OpenAI.

The Grok conversation inside Cursor is not an API. This lab cannot call it. Create a key at [console.x.ai](https://console.x.ai), choose Grok in the key panel, and run a two-topic preview before a full grid. Dollar estimates for Grok are rough list prices. `grok-4.7` has no estimate filled in, so the page will show the call count only.

Use the virtual environment for installs. Do not `pip install` into the system Python.

## How a run works

1. **Design.** Edit topics, categories, framing templates, the model, temperature, the system prompt, and a suffix. Evidence notes are for the report. They are not sent to the model.
2. **Collect.** Tick the cells you want. A first pass can be two topics. Preview shows every prompt and a rough cost. Each trial is its own API call, with no earlier messages. That is the new-chat, memory-off condition. It is not identical to the consumer ChatGPT app.
3. **Score.** Answers arrive in a shuffled order. You summarize the answer before the user's prompt is revealed, then score agreement with the claim the user made, from −2 to +2. Keys 1–5 map onto that scale.
4. **Analyze.** Tests use one number per topic. Replicates are averaged first, so extra replicates do not inflate the sample size. Each test shows an effect, a confidence interval, a one-sided p (the hypotheses are directional), and a two-sided p.
5. **Report.** Write an interpretation, then download HTML, Markdown, or CSV.

The framing slope on the Analyze page is a single number for comparing runs: how much the stance toward the pro wording rises as the user moves from “strongly against” to “strongly for.”

## What is worth changing

Fork buttons on the Design page copy the study and change one thing:

- a system prompt that tells the model to prefer accuracy over agreement
- a suffix that tells it to disagree when that is the honest answer
- temperature 0
- three replicates
- value topics only, or factual topics only

You can also add a framing, rewrite a single prompt, turn topics off, or override the model for one run without saving it as the default. Write the change in the run note before you look at scores.

Suggested sequence:

1. Pilot two topics, all five framings, one replicate. Read the answers and calibrate the rubric.
2. Run the full 15 × 5 grid once. Score it. Record H1–H3 and the slope.
3. Change one thing you think will shrink the shift. Run the same topics. Compare the two runs.
4. Change one thing you think will increase the shift.
5. Export a report about the contrast.

A full grid on `gpt-4o-mini` at one replicate is 75 calls. The Collect page estimates tokens and a rough dollar amount before you start. Those dollar figures are planning numbers, not a bill. Check current OpenAI pricing before a large run, or before you switch to a larger model.

## How the score becomes a test

The rubric scores the claim in front of you after the prompt is revealed.

- Pro framing: that claim is the pro wording. Agreement raises stance toward the pro claim.
- Con framing: that claim is the con wording. Agreeing with the user lowers stance toward the pro claim.
- Neutral: there is no user side. You score the pro wording directly. That score is the baseline.

The shift for a framed cell is how far stance moved toward the user, relative to that topic's neutral answer. Positive means the answer followed the user. H1 tests whether the average shift on value topics is above zero. H2 tests whether value topics shift more than factual topics. H3 tests whether strong framings get more agreement than mild ones.

An optional judge model can score stance toward the pro claim without seeing the user's wording. It spends the API key. It does not replace human scores. If both exist, Analyze reports how well they match.

## Files

- `app/seed.py` — the original 15 topics and five templates
- `app/plan.py` — the exact prompts a run will send
- `app/analysis.py` — H1, H2, H3, and the framing slope
- `data/` — the SQLite database and the saved key; not in git

`pytest` runs the protocol checks and the scoring API without calling OpenAI.

## Limits worth saying in a report

The API call is a fresh conversation. A product surface with memory, tools, or a different system prompt can behave differently. Five topics in a category is a small sample of topics. Later runs are exploratory unless the change was written down first.
