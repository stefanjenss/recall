import type { CardContent } from '../domain/types';

const MAKE_IT_STICK = 'Make It Stick (Brown, Roediger & McDaniel, 2014)';

/** Six editable sample cards across learning science and data systems. */
export const STARTER_CARDS: CardContent[] = [
  {
    topic: 'Learning science',
    kind: 'recall',
    question: 'What is the testing effect (retrieval practice)?',
    answer:
      'Actively retrieving something from memory strengthens it more than re-reading it. Each effortful recall makes the memory more durable and easier to reach later.\n\nExample: closing the book and writing down what you remember beats highlighting the chapter a second time.',
    source: MAKE_IT_STICK,
  },
  {
    topic: 'Data systems',
    kind: 'apply',
    question:
      'You need every customer, including customers who have never ordered, with their order count. Which join do you use, and what happens to a customer with no orders?',
    answer:
      'Use a `LEFT JOIN` from customers to orders and count a column from `orders`:\n\n```sql\nSELECT c.id, COUNT(o.id) AS order_count\nFROM customers AS c\nLEFT JOIN orders AS o ON o.customer_id = c.id\nGROUP BY c.id;\n```\n\nA customer with no orders keeps their row; the `orders` columns are `NULL`, so `COUNT(o.id)` returns 0. `COUNT(*)` would count the row itself and wrongly return 1.',
    source: null,
  },
  {
    topic: 'Learning science',
    kind: 'explain',
    question: 'Why does spacing practice out over time improve long-term retention, even though it feels harder?',
    answer:
      'Letting some forgetting happen makes the next retrieval more effortful, and effortful retrieval strengthens the memory and its connections. Massed practice feels fluent because the material is still fresh in short-term memory, which creates an illusion of mastery.',
    source: MAKE_IT_STICK,
  },
  {
    topic: 'Data systems',
    kind: 'explain',
    question: 'What does it mean for a pipeline step to be idempotent, and why does it matter?',
    answer:
      'Running the step more than once with the same input leaves the same result as running it once.\n\nIt matters because retries and backfills are routine. An idempotent load, such as overwriting a date partition or upserting by key, can be re-run safely; a blind append would create duplicates.',
    source: null,
  },
  {
    topic: 'Learning science',
    kind: 'compare',
    question: 'Compare blocked practice with interleaved practice.',
    answer:
      '- **Blocked:** practice one type of problem repeatedly before moving on (AAA BBB CCC). It feels productive and performance during practice is high.\n- **Interleaved:** mix problem types (ABC CAB BCA). It feels harder, but you learn to recognize which approach a problem needs, which improves later performance.',
    source: MAKE_IT_STICK,
  },
  {
    topic: 'Data systems',
    kind: 'recall',
    question: 'What does adding an index to a database column trade off?',
    answer:
      'Faster reads that filter, join, or sort on that column, in exchange for extra storage and slower writes, because every insert, update, or delete must also maintain the index.',
    source: null,
  },
];
