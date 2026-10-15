import { useMemo } from 'react';
import { href } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { LONG_INTERVAL_DAYS, percent, summarizeProgress } from '../../domain/stats';
import { formatDateTime, formatDay } from '../../domain/time';
import { CONFIDENCE_LABELS, CONFIDENCE_LEVELS, RATING_LABELS, RATINGS } from '../../domain/types';
import { PageHeader, StatList } from '../components/common';

const WINDOW = 14;

export function Progress() {
  const ws = useWorkspace();
  const tz = ws.preferences.timezone;
  const p = useMemo(
    () => summarizeProgress(ws.activeCards, ws.schedules, ws.reviews, ws.now, tz, WINDOW),
    [ws.activeCards, ws.schedules, ws.reviews, ws.now, tz],
  );
  const reflections = [...ws.reflections].sort((a, b) => b.createdAt - a.createdAt);

  if (p.totalReviews === 0) {
    return (
      <div className="screen progress">
        <PageHeader title="Progress" />
        <div className="panel empty-state">
          <h2>No reviews yet</h2>
          <p>Progress appears after your first committed review. Nothing here is estimated or invented.</p>
          <p>
            <a className="button button--primary" href={href('')}>
              Go to Today
            </a>
          </p>
        </div>
        <Reflections list={reflections} tz={tz} />
      </div>
    );
  }

  const max = Math.max(1, ...p.activity.map((d) => d.count));
  const peak = p.activity.reduce((a, b) => (b.count > a.count ? b : a), p.activity[0]!);

  return (
    <div className="screen progress">
      <PageHeader title="Progress" kicker="Signals from your saved reviews — not proof of mastery" />

      <StatList
        className="stat-list--four"
        items={[
          {
            label: 'Reviews, all time',
            value: p.totalReviews.toLocaleString(),
            note:
              p.quickChecks.total > 0
                ? `incl. ${p.quickChecks.total.toLocaleString()} quick check${p.quickChecks.total === 1 ? '' : 's'}`
                : undefined,
          },
          { label: `Last ${WINDOW} days`, value: p.reviewsInWindow.toLocaleString(), note: 'reviews' },
          { label: 'Today', value: p.reviewsToday, note: p.reviewsToday === 1 ? 'review' : 'reviews' },
          { label: 'Streak', value: p.streak, note: p.streak === 1 ? 'day' : 'days' },
        ]}
      />

      <section className="section" aria-labelledby="activity-title">
        <h2 id="activity-title" className="section__title">
          Reviews per day, last {WINDOW} days
        </h2>
        <div
          className="activity"
          role="img"
          aria-label={`Review activity for the last ${WINDOW} days. Busiest day: ${formatDay(peak.day)} with ${peak.count} reviews. Full numbers in the table below.`}
        >
          <div className="activity__plot">
            {p.activity.map((d, i) => {
              const isToday = i === p.activity.length - 1;
              const labelled = (d.count === max && d.count > 0) || isToday;
              return (
                <div
                  className="activity__col"
                  key={d.day}
                  title={`${formatDay(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}: ${d.count} review${d.count === 1 ? '' : 's'}`}
                >
                  <span className={`activity__value${labelled ? '' : ' is-quiet'}`}>{d.count}</span>
                  <span
                    className={`activity__bar${isToday ? ' is-today' : ''}`}
                    style={{ height: `${(d.count / max) * 100}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="activity__axis" aria-hidden="true">
            {p.activity.map((d) => (
              <span key={d.day}>{formatDay(d.day, { weekday: 'narrow' })}</span>
            ))}
          </div>
          <p className="activity__range muted small" aria-hidden="true">
            {formatDay(p.activity[0]!.day)} – {formatDay(p.activity.at(-1)!.day)}
          </p>
        </div>
        <details className="disclosure">
          <summary>Show as a table</summary>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="num">
                  Reviews
                </th>
              </tr>
            </thead>
            <tbody>
              {p.activity.map((d) => (
                <tr key={d.day}>
                  <td>{formatDay(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td className="num">{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <p className="muted small">Days follow your timezone setting ({tz}).</p>
      </section>

      <div className="two-col">
        <section className="section" aria-labelledby="ratings-title">
          <h2 id="ratings-title" className="section__title">
            Self-ratings <span className="muted">(self-reported, all time)</span>
          </h2>
          <p className="lead-stat">
            <strong>{percent(p.goodOrEasy)}</strong> rated Good or Easy
            <span className="muted">
              {' '}
              · {p.goodOrEasy.count} of {p.goodOrEasy.total} reviews
            </span>
          </p>
          <table className="table bars">
            <tbody>
              {RATINGS.map((r) => {
                const n = p.ratingCounts[r];
                return (
                  <tr key={r}>
                    <th scope="row">{RATING_LABELS[r]}</th>
                    <td className="bars__cell">
                      <span className="bars__bar" style={{ width: n > 0 ? `max(2px, ${(n / p.recallReviews) * 100}%)` : 0 }} />
                    </td>
                    <td className="num">
                      {n} <span className="muted">({percent({ count: n, total: p.recallReviews })})</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small">
            These are your own judgments at review time. They show how practice felt, not what you can do later.
          </p>

          {p.quickChecks.total > 0 ? (
            <>
              <h2 id="quick-checks-title" className="section__title">
                Quick checks <span className="muted">(recognition, not recall)</span>
              </h2>
              <p className="lead-stat">
                <strong>{percent(p.quickChecks)}</strong> picked correctly
                <span className="muted">
                  {' '}
                  · {p.quickChecks.count} of {p.quickChecks.total} quick checks
                </span>
              </p>
              <p className="muted small">
                Picking the right option shows you can recognize an answer, which is easier than producing it. Quick checks aren’t
                counted in the self-ratings above and never lengthen an interval.
              </p>
            </>
          ) : null}
        </section>

        <section className="section" aria-labelledby="intervals-title">
          <h2 id="intervals-title" className="section__title">
            Longer intervals
          </h2>
          <p className="lead-stat">
            <strong>{p.longIntervals.count}</strong> of {p.longIntervals.total} cards
            <span className="muted"> are scheduled {LONG_INTERVAL_DAYS}+ days apart</span>
          </p>
          <p className="muted small">
            A long interval means you’ve recalled the card successfully several times with growing gaps. It reflects spacing, not
            mastery.
          </p>

          <h2 id="calibration-title" className="section__title">
            Confidence vs. self-rating <span className="muted">(experimental)</span>
          </h2>
          <table className="table" aria-labelledby="calibration-title">
            <thead>
              <tr>
                <th scope="col">Confidence before checking</th>
                <th scope="col" className="num">
                  Reviews
                </th>
                <th scope="col" className="num">
                  Rated Good/Easy
                </th>
              </tr>
            </thead>
            <tbody>
              {CONFIDENCE_LEVELS.map((c) => (
                <tr key={c}>
                  <th scope="row">{CONFIDENCE_LABELS[c]}</th>
                  <td className="num">{p.calibration[c].total}</td>
                  <td className="num">{percent(p.calibration[c])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            {p.withoutConfidence} review{p.withoutConfidence === 1 ? '' : 's'} had no confidence recorded. Small samples are
            noisy; if “Confident” answers are often rated Again, those cards may deserve a closer look.
          </p>
        </section>
      </div>

      <Reflections list={reflections} tz={tz} />
    </div>
  );
}

function Reflections({ list, tz }: { list: { id: string; body: string; createdAt: number }[]; tz: string }) {
  return (
    <section className="section" aria-labelledby="reflections-title">
      <h2 id="reflections-title" className="section__title">
        Reflections
      </h2>
      {list.length === 0 ? (
        <p className="muted">After a session you can jot down what felt shaky or what connected. Notes appear here.</p>
      ) : (
        <ol className="reflection-list">
          {list.map((r) => (
            <li key={r.id}>
              <p className="reflection-list__date">{formatDateTime(r.createdAt, tz, { year: 'numeric' })}</p>
              <p className="reflection-list__body">{r.body}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
