import type { ReactNode } from "react";

/**
 * Presentational pieces for /verify that /auth/action's ui.tsx does not
 * have. Same visual language (that file's Card, Title, Body and buttons
 * are reused as they are): 16px inputs so iOS does not zoom, 48px touch
 * targets, one column.
 */

export function VerifyShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[42vh] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(203,119,90,0.28),transparent_70%)]"
      />
      <div className="relative z-10 flex min-h-screen flex-col items-center px-5 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <div className="font-tape select-none text-sm font-extrabold uppercase tracking-[0.3em] text-white/80">
          Tape Members
        </div>
        <div className="mt-6 w-full max-w-md">{children}</div>
        <p className="mt-8 max-w-xs text-center text-xs font-light leading-relaxed text-white/40">
          Need a hand? Ask the door staff.
        </p>
      </div>
    </main>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  inputMode,
  autoCapitalize,
  maxLength,
  enterKeyHint,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  inputMode?: "text" | "email" | "numeric";
  autoCapitalize?: "none" | "words" | "characters";
  maxLength?: number;
  enterKeyHint?: "next" | "done" | "go";
  autoFocus?: boolean;
}) {
  return (
    <div className="mt-4">
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs uppercase tracking-wide text-white/60"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        autoCapitalize={autoCapitalize}
        autoCorrect="off"
        spellCheck={false}
        maxLength={maxLength}
        enterKeyHint={enterKeyHint}
        autoFocus={autoFocus}
        className="w-full rounded-xl border border-white/25 bg-white/5 px-4 py-3.5 text-base text-white placeholder-white/40 outline-none transition focus:border-white/60 focus:bg-white/10"
      />
    </div>
  );
}

/** One of two (or more) large options; nothing is chosen to begin with. */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="mt-3 grid grid-cols-2 gap-3">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`min-h-12 rounded-xl border px-3 py-3 text-base font-medium transition ${
              on
                ? "border-[#cb775a] bg-[#cb775a]/20 text-white"
                : "border-white/25 bg-white/5 text-white/80 hover:bg-white/10"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-4 text-center text-sm font-medium text-red-300">
      {children}
    </p>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 text-center text-sm font-light leading-relaxed text-white/60">
      {children}
    </p>
  );
}

export function TextLink({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-4 block w-full text-center text-sm text-white/60 underline underline-offset-4 transition hover:text-white disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mt-6 text-xs uppercase tracking-wide text-white/60">{children}</p>
  );
}
