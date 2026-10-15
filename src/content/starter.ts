import type { CardContent } from '../domain/types';

const MAKE_IT_STICK = 'Make It Stick (Brown, Roediger & McDaniel, 2014)';

/** Six editable sample cards across learning science and data systems, each with quick-check options. */
export const STARTER_CARDS: CardContent[] = [
  {
    topic: 'Learning science',
    kind: 'recall',
    question: 'What is the testing effect (retrieval practice)?',
    answer:
      'Actively retrieving something from memory strengthens it more than re-reading it. Each effortful recall makes the memory more durable and easier to reach later.\n\nExample: closing the book and writing down what you remember beats highlighting the chapter a second time.',
    source: MAKE_IT_STICK,
    choices: {
      correct: 'Pulling information out of memory strengthens it more than reading it again.',
      distractors: [
        'Re-reading material several times strengthens it more than quizzing yourself.',
        'Tests mainly measure learning; the studying beforehand is what builds memory.',
        'Memory grows strongest when you read the answer just before trying to recall it.',
      ],
    },
  },
  {
    topic: 'Data systems',
    kind: 'apply',
    question:
      'You need every customer, including customers who have never ordered, with their order count. Which join do you use, and what happens to a customer with no orders?',
    answer:
      'Use a `LEFT JOIN` from customers to orders and count a column from `orders`:\n\n```sql\nSELECT c.id, COUNT(o.id) AS order_count\nFROM customers AS c\nLEFT JOIN orders AS o ON o.customer_id = c.id\nGROUP BY c.id;\n```\n\nA customer with no orders keeps their row; the `orders` columns are `NULL`, so `COUNT(o.id)` returns 0. `COUNT(*)` would count the row itself and wrongly return 1.',
    source: null,
    choices: {
      correct: '`LEFT JOIN` customers to orders and count `o.id`; customers with no orders get 0.',
      distractors: [
        '`INNER JOIN` customers to orders and count `o.id`; customers with no orders get 0.',
        '`LEFT JOIN` customers to orders and use `COUNT(*)`; customers with no orders get 0.',
        '`RIGHT JOIN` customers to orders and count `o.id`; customers with no orders get `NULL`.',
      ],
    },
  },
  {
    topic: 'Learning science',
    kind: 'explain',
    question: 'Why does spacing practice out over time improve long-term retention, even though it feels harder?',
    answer:
      'Letting some forgetting happen makes the next retrieval more effortful, and effortful retrieval strengthens the memory and its connections. Massed practice feels fluent because the material is still fresh in short-term memory, which creates an illusion of mastery.',
    source: MAKE_IT_STICK,
    choices: {
      correct: 'Some forgetting makes the next recall more effortful, and effortful recall strengthens the memory.',
      distractors: [
        'Spacing lets the brain replay the material, so less effort is needed at the next review.',
        'Spaced sessions are shorter, so attention stays higher and more is stored each time.',
        'Spacing prevents forgetting, so every review starts from a fully intact memory.',
      ],
    },
  },
  {
    topic: 'Data systems',
    kind: 'explain',
    question: 'What does it mean for a pipeline step to be idempotent, and why does it matter?',
    answer:
      'Running the step more than once with the same input leaves the same result as running it once.\n\nIt matters because retries and backfills are routine. An idempotent load, such as overwriting a date partition or upserting by key, can be re-run safely; a blind append would create duplicates.',
    source: null,
    choices: {
      correct: 'Running it again with the same input leaves the same result as running it once, so retries are safe.',
      distractors: [
        'It always returns the same output for the same input, so its results can be cached.',
        'It runs exactly once per input, so the scheduler never needs to retry it.',
        'It only processes records added since the last run, so it never reads a row twice.',
      ],
    },
  },
  {
    topic: 'Learning science',
    kind: 'compare',
    question: 'Compare blocked practice with interleaved practice.',
    answer:
      '- **Blocked:** practice one type of problem repeatedly before moving on (AAA BBB CCC). It feels productive and performance during practice is high.\n- **Interleaved:** mix problem types (ABC CAB BCA). It feels harder, but you learn to recognize which approach a problem needs, which improves later performance.',
    source: MAKE_IT_STICK,
    choices: {
      correct: 'Blocked feels more productive in practice; interleaved feels harder but improves later performance.',
      distractors: [
        'Blocked feels harder in practice; interleaved feels easier and improves later performance.',
        'Interleaved feels more productive in practice; blocked improves later performance.',
        'Both lead to the same later performance; interleaved only takes longer per session.',
      ],
    },
  },
  {
    topic: 'Data systems',
    kind: 'recall',
    question: 'What does adding an index to a database column trade off?',
    answer:
      'Faster reads that filter, join, or sort on that column, in exchange for extra storage and slower writes, because every insert, update, or delete must also maintain the index.',
    source: null,
    choices: {
      correct: 'Faster reads on that column in exchange for extra storage and slower writes.',
      distractors: [
        'Faster writes to that column in exchange for extra storage and slower reads.',
        'Faster reads on that column in exchange for weaker consistency guarantees.',
        'Less storage for that column in exchange for slower reads and joins.',
      ],
    },
  },
];
