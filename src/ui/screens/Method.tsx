import { QUICK_CHECK_LIMIT } from '../../domain/scheduler';
import { PageHeader } from '../components/common';

export const LEARNING_NOTES = [
  {
    title: 'Retrieval',
    body: 'Pulling an answer out of memory strengthens it far more than re-reading it. Try to answer before you look, even when you’re unsure.',
  },
  {
    title: 'Spacing',
    body: 'A little forgetting between reviews makes the next recall harder and the memory stronger. That’s why cards come back at growing intervals.',
  },
  {
    title: 'Interleaving',
    body: 'Mixed topics feel harder than practicing one thing at a time, but they train you to recognize which idea a problem needs.',
  },
  {
    title: 'Generation',
    body: 'Attempting an answer before seeing it—even a wrong attempt—makes the correct answer stick better when you check.',
  },
  {
    title: 'Elaboration',
    body: 'Connect an answer to something you already know, or put it in your own words with an example. Connections give a memory more ways back in.',
  },
  {
    title: 'Calibration',
    body: 'Fluency feels like knowing. Rating your confidence before you check shows where that feeling is misleading you.',
  },
  {
    title: 'Reflection',
    body: 'A minute after practice to note what was shaky or what connected turns a session into a plan for the next one.',
  },
] as const;

export function Method() {
  return (
    <div className="screen method">
      <PageHeader title="The method" kicker="Why Recall works the way it does" />

      <div className="method__intro prose">
        <p>
          Recall is built around a few well-supported findings about how durable learning happens, popularized in{' '}
          <cite>Make It Stick: The Science of Successful Learning</cite> by Peter C. Brown, Henry L. Roediger III, and Mark A.
          McDaniel (Harvard University Press, 2014). The goal isn’t to recognize familiar text; it’s to produce and apply what you
          know after time has passed.
        </p>
      </div>

      <section className="section" aria-labelledby="principles-title">
        <h2 id="principles-title" className="section__title">
          Principles and how the app applies them
        </h2>
        <dl className="principles">
          <div>
            <dt>Retrieval</dt>
            <dd>
              Every card shows the question first and gives you room to answer—typed or aloud—before you can reveal the answer.
            </dd>
          </div>
          <div>
            <dt>Spacing</dt>
            <dd>
              Each card has its own due time and interval. Cards you recall well come back later; cards you miss come back soon.
            </dd>
          </div>
          <div>
            <dt>Interleaving</dt>
            <dd>
              Sessions alternate topics where possible. Mixing alone isn’t magic: it helps most when your cards include
              comparisons and varied applications that make you choose an approach.
            </dd>
          </div>
          <div>
            <dt>Generation</dt>
            <dd>
              Apply and Compare cards ask you to work something out, not just repeat a definition. Attempt first, then check.
            </dd>
          </div>
          <div>
            <dt>Elaboration</dt>
            <dd>
              Good answers include an example or a reason. When you rate, ask whether you could explain it, not just say it.
            </dd>
          </div>
          <div>
            <dt>Calibration</dt>
            <dd>
              The optional confidence choice is recorded before you see the answer, separately from your rating, so you can
              compare how sure you felt with how it went.
            </dd>
          </div>
          <div>
            <dt>Reflection</dt>
            <dd>After each session you can save a short note. Notes live in Progress.</dd>
          </div>
        </dl>
      </section>

      <section className="section" aria-labelledby="scheduler-title">
        <h2 id="scheduler-title" className="section__title">
          How scheduling works
        </h2>
        <p className="prose">
          Recall uses its own simple rules, called <code>recall-sm2-v2</code>. They’re inspired by the classic SM-2 approach but
          are not Anki’s algorithm, not FSRS, and not a prescription from the book. Each card tracks an interval (I, in days), an
          ease (E, starting at 2.5), and how many times you’ve reviewed it (R).
        </p>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Scheduling rules table">
          <table className="table scheduler-table">
            <thead>
              <tr>
                <th scope="col">Your rating</th>
                <th scope="col">Next interval</th>
                <th scope="col">Ease</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Again</th>
                <td>10 minutes</td>
                <td>E − 0.20 (min 1.3)</td>
              </tr>
              <tr>
                <th scope="row">Hard</th>
                <td>1 day if new or just missed; otherwise I × 1.2</td>
                <td>E − 0.15 (min 1.3)</td>
              </tr>
              <tr>
                <th scope="row">Good</th>
                <td>1 day if new or just missed; otherwise I × E (at least I + 1)</td>
                <td>unchanged</td>
              </tr>
              <tr>
                <th scope="row">Easy</th>
                <td>4 days if new or just missed; otherwise I × E × 1.3 (at least I + 1)</td>
                <td>E + 0.15 (max 3.5)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul className="prose">
          <li>Intervals are capped at 10 years. The due time is the moment you rate plus the interval.</li>
          <li>
            Sessions put cards you’ve seen before ahead of new cards, oldest due first, and alternate topics within each group
            when they can.
          </li>
          <li>
            A card rated Again isn’t repeated in the same session; it becomes due again 10 minutes later for your next session.
          </li>
          <li>Due times are never pulled forward to give you more to do. Being caught up is fine.</li>
          <li>
            Version 2 added the quick-check rule below. Every rating rule above is unchanged from version 1,{' '}
            <code>recall-sm2-v1</code>.
          </li>
        </ul>
      </section>

      <section className="section" aria-labelledby="quick-check-title">
        <h2 id="quick-check-title" className="section__title">
          Quick checks
        </h2>
        <p className="prose">
          On a low-energy day, choose Quick check on Today. Cards that have multiple-choice options show them instead of an answer
          box, and your pick is checked for you. It keeps the habit going and catches what you’ve forgotten. But recognizing an
          answer is easier than producing it, so a quick check counts for less than a full recall:
        </p>
        <ul className="prose">
          <li>
            A correct pick brings the card back in 1 day, or 2 once its interval is at least 2 days. Its interval, ease, and
            review count don’t change, so a lucky guess can’t push a card further out.
          </li>
          <li>A wrong pick counts as Again: the card returns in 10 minutes with the same ease penalty.</li>
          <li>
            After {QUICK_CHECK_LIMIT} quick checks in a row, a card waits for a full recall. Any full-recall review resets the
            count.
          </li>
          <li>
            Drawing a blank in a full-recall session? A card that has options offers Show options before you reveal the answer.
            That card becomes a quick check, under the same rules and counting toward the same limit. Anything you typed is kept
            with it but not scored.
          </li>
          <li>Progress reports quick checks on their own line. They aren’t self-ratings and never lengthen an interval.</li>
        </ul>
      </section>

      <section className="section" aria-labelledby="limits-title">
        <h2 id="limits-title" className="section__title">
          Honest limits
        </h2>
        <ul className="prose">
          <li>
            Self-ratings, streaks, and long intervals are signals about your practice. They are not proof you’ve mastered
            something. The real test is whether you can produce and use the idea later.
          </li>
          <li>The interval rules and session defaults are design choices, not measured optima.</li>
          <li>
            Multiple-choice options can make a card feel easier than it is, and a wrong option you pick can stick. Quick checks
            supplement recall; they don’t replace it.
          </li>
          <li>
            Recall doesn’t grade your answers with AI in this version. You compare your answer with the reference and rate it
            yourself.
          </li>
          <li>Your data lives in this browser only. Use backups to keep it safe or move it to another device.</li>
        </ul>
      </section>
    </div>
  );
}
