/**
 * Login and first-run setup.
 *
 * These are one screen with two modes rather than two routes: which one you get
 * is a fact about the server ("has a password been set?"), not a place the user
 * navigates to, so putting it in the URL would only create a state the user can
 * land on wrongly.
 */

import { api } from "../api";
import { el, guard, toast } from "../ui";

export function renderLogin(root: HTMLElement, setupRequired: boolean, onAuthenticated: () => void): void {
  const wrap = el("div", {
    style: "max-width:380px; margin:12vh auto; text-align:center;",
  });

  const heading = el("h2", { class: "view-title" });
  heading.textContent = setupRequired ? "Set up Pineart" : "Pineart";

  const intro = el("p", { class: "view-desc", style: "margin-left:auto; margin-right:auto;" });
  intro.textContent = setupRequired
    ? "This instance has no password yet. Copy the one-time setup token from the server log to claim it."
    : "Enter your password to continue.";

  const form = el("form", { style: "text-align:left;" });

  const tokenLabel = el("label", { class: "hint", style: "display:block; margin-bottom:5px;" });
  tokenLabel.textContent = "Setup token";
  const tokenInput = el("input", {
    type: "text",
    autocomplete: "off",
    style: "width:100%; margin-bottom:14px;",
  }) as HTMLInputElement;

  const passwordLabel = el("label", { class: "hint", style: "display:block; margin-bottom:5px;" });
  passwordLabel.textContent = setupRequired ? "Choose a password (10+ characters)" : "Password";
  const passwordInput = el("input", {
    type: "password",
    autocomplete: setupRequired ? "new-password" : "current-password",
    style: "width:100%;",
  }) as HTMLInputElement;

  const confirmLabel = el("label", { class: "hint", style: "display:block; margin:14px 0 5px;" });
  confirmLabel.textContent = "Confirm password";
  const confirmInput = el("input", {
    type: "password",
    autocomplete: "new-password",
    style: "width:100%;",
  }) as HTMLInputElement;

  // A first-run flow asks for a display name up front rather than dropping
  // straight into an unconfigured, empty app and hoping the person finds
  // Settings on their own (advance.md §5). Optional — leaving it blank is a
  // legitimate choice, just not the one made silently by never asking.
  const nameLabel = el("label", { class: "hint", style: "display:block; margin:14px 0 5px;" });
  nameLabel.textContent = "Display name (optional)";
  const nameInput = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "e.g. Alex's collection",
    style: "width:100%;",
  }) as HTMLInputElement;

  const submit = el("button", {
    type: "submit",
    class: "btn btn-filled",
    style: "margin-top:18px; width:100%; justify-content:center;",
  }) as HTMLButtonElement;
  submit.textContent = setupRequired ? "Claim this instance" : "Log in";

  const error = el("p", { class: "hint", style: "color:#b3212e; margin-top:12px;" });
  error.hidden = true;

  if (setupRequired) form.append(tokenLabel, tokenInput);
  form.append(passwordLabel, passwordInput);
  if (setupRequired) {
    form.append(confirmLabel, confirmInput, nameLabel, nameInput);
  }
  form.append(submit, error);

  const hint = el("p", { class: "hint", style: "margin-top:22px;" });
  hint.textContent = setupRequired
    ? "The token is printed to the server log at startup and is regenerated on restart."
    : "Forgot it? Run `python -m app.cli set-password` on the server.";

  wrap.append(heading, intro, form, hint);
  root.replaceChildren(wrap);
  (setupRequired ? tokenInput : passwordInput).focus();

  form.addEventListener(
    "submit",
    guard(async (event: SubmitEvent) => {
      event.preventDefault();
      error.hidden = true;

      if (setupRequired && passwordInput.value !== confirmInput.value) {
        error.textContent = "The two passwords do not match.";
        error.hidden = false;
        return;
      }

      submit.disabled = true;
      try {
        if (setupRequired) {
          await api.setup(passwordInput.value, tokenInput.value.trim());
          const displayName = nameInput.value.trim();
          if (displayName) {
            // Best-effort: a failure here shouldn't block finishing setup —
            // the name can always be set later from Settings → Profile.
            await api.putSettings({ "profile.display_name": displayName }).catch(() => undefined);
          }
          toast("Instance claimed — welcome. Add your first images from Settings whenever you're ready.");
        } else {
          await api.login(passwordInput.value);
        }
        onAuthenticated();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : String(failure);
        error.hidden = false;
        passwordInput.select();
      } finally {
        submit.disabled = false;
      }
    }),
  );
}
