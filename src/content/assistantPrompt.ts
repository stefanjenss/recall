import { IMPORT_MAX_CARDS, LIMITS, MAX_DISTRACTORS } from '../domain/limits';

export interface PromptOptions {
  material: string;
  topic: string;
  count: number;
}

export const MATERIAL_PLACEHOLDER = '[Paste the concepts, terms, or notes to turn into cards here]';

/**
 * A provider-neutral prompt for any assistant that can return JSON. The
 * result is pasted back into Import; nothing is sent anywhere by the app.
 */
export function buildAssistantPrompt({ material, topic, count }: PromptOptions): string {
  const n = Math.max(1, Math.min(IMPORT_MAX_CARDS, Math.round(count) || 10));
  const topicLine = topic.trim()
    ? `Use the topic "${topic.trim()}" unless a card clearly belongs to a narrower subtopic.`
    : 'Give each card a short topic name (for example "SQL joins" or "Python generators").';

  return `Create about ${n} flashcards for Recall, a spaced-repetition study app, from the material below.

MATERIAL
<<<
${material.trim() || MATERIAL_PLACEHOLDER}
>>>

HOW TO WRITE THE CARDS
- One learning objective per card. Split broad ideas into several focused cards.
- Ask questions that require producing the answer from memory, not recognizing it. Avoid yes/no questions.
- Mix the kinds:
  - "recall": retrieve a fact, definition, or rule.
  - "apply": use the idea in a concrete scenario or problem.
  - "compare": distinguish two related ideas or approaches.
  - "explain": say why or how something works.
- Keep answers concise: state the key idea first, then a short example where it helps.
- Use Markdown for lists, \`inline code\`, and fenced code blocks.
- Only include a "source" when the material names one. Never invent citations.
- If the material is unclear or too thin for a card, leave that card out rather than guessing.
- ${topicLine}

MULTIPLE-CHOICE OPTIONS
Each card can also carry a multiple-choice version in "choices", used for quick checks when the learner wants a lighter review. The question and full answer stay the main card.
- "correct": a short statement of the right answer (one line, not the whole explanation).
- "distractors": exactly ${MAX_DISTRACTORS} wrong options that are plausible to someone who half-knows the material, such as common misconceptions or a related idea applied in the wrong place.
- Match the length, style, and level of detail of the correct option so the answer can't be spotted by its form.
- No "all of the above", "none of the above", jokes, or options that are only partly wrong.
- If a card doesn't have a fair multiple-choice form (for example, a long explanation), use "choices": null.

OUTPUT
Return only JSON in exactly this shape, with no commentary before or after it:

{
  "format": "recall-v1",
  "cards": [
    {
      "topic": "Short topic name (max ${LIMITS.topic} characters)",
      "kind": "recall",
      "question": "The prompt (max ${LIMITS.question} characters)",
      "answer": "The reference answer (max ${LIMITS.answer} characters)",
      "source": null,
      "choices": {
        "correct": "The right answer in one line (max ${LIMITS.choice} characters)",
        "distractors": ["A plausible wrong option", "Another plausible wrong option", "A third plausible wrong option"]
      }
    }
  ]
}

"kind" must be one of "recall", "apply", "compare", "explain". "source" is a string or null. "choices" is an object or null. Return at most ${IMPORT_MAX_CARDS} cards.`;
}
