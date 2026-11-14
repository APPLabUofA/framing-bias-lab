# Review & Ideas for Your Framing Experiment

*A strong first proposal — here are a few small tweaks and follow-up runs you can test in the lab.*

## What Works Well Already

- **3 × 5 within-topic design:** Crossing **Factual**, **Contested**, and **Value** topics with five framing levels (**Strong Con → Neutral → Strong Pro**) gives every topic its own neutral baseline.
- **Clean variable control:** Starting a fresh chat with memory off for each prompt keeps earlier answers from spilling over into the next trial.
- **Solid blinding:** Randomizing answers and summarizing them before seeing the prompt is a smart way to keep your own expectations out of the ratings.
- **Clear hypotheses (H1–H3):** Each prediction maps straight onto a specific comparison in your grid.

## Three Small Tweaks for Your Baseline

1. **Balance true and false factual claims:** Right now, 4 of your 5 factual "pro" claims are myths (like *vaccines cause autism*). On a neutral prompt, the model already scores **−2**, so a "Con" prompt (*"vaccines don't cause autism"*) has no room left to move on the scale (a floor effect). Flipping one or two factual items so half are **true** claims gives the scale equal room in both directions.
2. **Pick the −2 to +2 score before revealing the prompt:** Right now the summary is blind, but the prompt is revealed before you pick the number. Scoring the stance toward the main claim *while the prompt is still hidden* stops a strong prompt from nudging your rating at the last second—and saves you from flipping plus/minus signs on "Con" prompts.
3. **Watch for "polite echoing":** Chatbots often start with *"I understand why you think..."* That first line can give away the framing during blind scoring, and raises a neat follow-up question: is the model changing its mind, or just being polite up front?

## Easy Follow-Ups to Test in the App

Once your baseline run is scored, change **one thing at a time** and run it again:

- **Write a prediction first:** Jot down what you expect before hitting **Start**, then compare it to the result.
- **Run the exact same setup twice (or at Temperature 0):** See how much answers wobble by chance before deciding a tweak made a difference.
- **Test a system prompt:** Try telling the model *"Prioritize accuracy over agreeing"* or *"Do not echo the user's opinion"* and see if H1 and H3 shrink.
- **Vary the framing style:** Swap *"I think..."* for authority framing (*"Most researchers agree..."*) or a loaded question (*"Why does..."*).
- **Add a few more topics:** Moving from 5 to 8–10 topics per group is an easy way to see how a larger sample (*N*) tightens your confidence intervals.
