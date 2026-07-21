/**
 * A dropdown that does not hand its popup to the operating system.
 *
 * A native <select> on macOS opens a system-drawn menu. That menu inherits the
 * document's text colour — which the SDK stylesheet sets to white — but does
 * not reliably take a background-color from CSS, so the entries end up white on
 * white, legible only on whichever row the pointer happens to be over. Whether
 * the background is honoured varies by platform and engine build, so styling
 * the native control means guessing which of two behaviours you will get.
 * Drawing the list ourselves removes the guess.
 *
 * Mirrors the slice of the <select> API this panel actually uses: `value`,
 * `setOptions()` and a change callback.
 */
class PiSelect {
  #root;
  #trigger;
  #label;
  #list;
  #options = [];
  #value = '';
  #onChange;
  #open = false;

  constructor(mount, { placeholder = 'Nothing selected', onChange = () => {} } = {}) {
    this.#onChange = onChange;
    this.placeholder = placeholder;

    this.#root = document.createElement('div');
    this.#root.className = 'pisel';

    this.#trigger = document.createElement('button');
    this.#trigger.type = 'button';
    this.#trigger.className = 'pisel-trigger';
    this.#trigger.setAttribute('aria-haspopup', 'listbox');
    this.#trigger.setAttribute('aria-expanded', 'false');

    this.#label = document.createElement('span');
    this.#label.className = 'pisel-label';
    this.#label.textContent = placeholder;

    const caret = document.createElement('span');
    caret.className = 'pisel-caret';

    this.#trigger.append(this.#label, caret);

    this.#list = document.createElement('div');
    this.#list.className = 'pisel-list';
    this.#list.setAttribute('role', 'listbox');

    this.#root.append(this.#trigger, this.#list);
    mount.replaceWith(this.#root);

    this.#trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    document.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  get value() {
    return this.#value;
  }

  set value(v) {
    this.#value = v || '';
    this.#render();
  }

  set disabled(on) {
    this.#trigger.disabled = !!on;
    if (on) this.close();
  }

  /** options: [{ value, label, note }] — `note` renders as a dim suffix. */
  setOptions(options) {
    this.#options = options || [];
    if (this.#value && !this.#options.some((o) => o.value === this.#value)) {
      // Keep a saved device visible even when a rescan did not turn it up, so
      // the panel never silently forgets what the button is pointed at.
      this.#options = [...this.#options, { value: this.#value, label: this.#value, note: 'saved' }];
    }
    this.#render();
  }

  toggle() {
    this.#open ? this.close() : this.open();
  }

  open() {
    if (this.#trigger.disabled || !this.#options.length) return;
    this.#open = true;
    this.#root.classList.add('open');
    this.#trigger.setAttribute('aria-expanded', 'true');
  }

  close() {
    if (!this.#open) return;
    this.#open = false;
    this.#root.classList.remove('open');
    this.#trigger.setAttribute('aria-expanded', 'false');
  }

  #render() {
    const chosen = this.#options.find((o) => o.value === this.#value);
    this.#label.textContent = chosen ? `${chosen.label}${chosen.note ? ` (${chosen.note})` : ''}` : this.placeholder;
    this.#label.classList.toggle('placeholder', !chosen);

    this.#list.innerHTML = '';
    for (const opt of this.#options) {
      const row = document.createElement('div');
      row.className = 'pisel-option' + (opt.value === this.#value ? ' selected' : '');
      row.setAttribute('role', 'option');

      const main = document.createElement('span');
      main.className = 'pisel-option-label';
      main.textContent = opt.label;
      row.appendChild(main);

      if (opt.note) {
        const note = document.createElement('span');
        note.className = 'pisel-option-note';
        note.textContent = opt.note;
        row.appendChild(note);
      }

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const changed = this.#value !== opt.value;
        this.#value = opt.value;
        this.close();
        this.#render();
        if (changed) this.#onChange(opt.value);
      });

      this.#list.appendChild(row);
    }
  }
}

window.PiSelect = PiSelect;
