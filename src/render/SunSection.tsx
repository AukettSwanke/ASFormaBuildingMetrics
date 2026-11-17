// The Sun section: follow Forma's sun, or choose a date and time in the project's time zone.

import { formatClock } from '../timeZone';
import { Field, Segmented } from '../ui';
import type { SunState } from './useSun';
import { STUDY_DATES, inputValue } from './shared';

/** Buttons for the equinoxes and solstices; `onPick` gets "mm-dd". */
export function QuickDates({ onPick }: { onPick: (monthDay: string) => void }) {
    return (
        <div class="segmented segmented--fill segmented--compact" role="group" aria-label="Standard dates">
            {STUDY_DATES.map(([label, monthDay]) => (
                <button key={monthDay} type="button" onClick={() => onPick(monthDay)}>{label}</button>
            ))}
        </div>
    );
}

export function SunSection({ sun, busy }: { sun: SunState; busy: boolean }) {
    return (
        <div class="section">
            <div class="section__head">
                <h3>Sun</h3>
                <button class="button-ghost" onClick={() => sun.read()} disabled={busy} title="Read Forma's sun and project location again">
                    Re-read
                </button>
            </div>
            <Segmented label="Sun position" fill value={sun.mode} onChange={sun.chooseMode}
                options={[['forma', 'Follow Forma'], ['custom', 'Choose a time']]} />
            {sun.mode === 'custom' && (
                <div style={{ marginTop: '0.8em' }}>
                    <Field label="Date" htmlFor="re-date">
                        <input id="re-date" type="date" value={sun.customDate}
                            onInput={(e) => sun.setCustomDate(inputValue(e))} />
                    </Field>
                    <Field label=""><QuickDates onPick={(monthDay) => sun.setCustomDate(`${sun.customDate.slice(0, 4)}-${monthDay}`)} /></Field>
                    <Field label="Time" htmlFor="re-time" value={formatClock(sun.customMinutes)}>
                        <input id="re-time" type="range" min="0" max="1430" step="10" value={sun.customMinutes}
                            onInput={(e) => sun.setCustomMinutes(Number(inputValue(e)))} />
                    </Field>
                    <div class="actions">
                        <button class="button-ghost" onClick={sun.applyToForma} disabled={busy}>Set Forma's sun to this</button>
                    </div>
                </div>
            )}
            <p class="help" role="status">{sun.text}</p>
        </div>
    );
}
