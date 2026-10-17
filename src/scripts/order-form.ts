/**
 * Client-side behaviour for the advertising order form.
 *
 * - Shows a live order summary (display only; the Worker always re-calculates
 *   the price server-side from the trusted pricing module).
 * - Switches between text and image creative fields.
 * - Fetches a stateless CSRF token and submits the order, then redirects to
 *   Stripe Checkout. Never treats the redirect as proof of payment: on return
 *   it polls the public order status, which only the verified webhook updates.
 */

interface PriceEntry {
  unit: number;
  total: number;
  discount: number;
}
type PriceTable = Record<string, Record<string, PriceEntry>>;

const money = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

/** "3 months — $81 total" — kept in sync with the server-rendered labels. */
const durationOptionLabel = (months: number, total: number) =>
  `${months === 1 ? '1 month' : `${months} months`} — ${money(total)} total`;

function readJson<T>(id: string): T {
  const el = document.getElementById(id);
  if (!el?.textContent) throw new Error(`Missing configuration #${id}`);
  return JSON.parse(el.textContent) as T;
}

const priceTable = readJson<PriceTable>('ads-price-table');
const placementLabels = readJson<Record<string, string>>('ads-price-labels');

const form = document.getElementById('ads-order-form') as HTMLFormElement | null;
const submitButton = document.getElementById('ads-submit') as HTMLButtonElement | null;
const summaryTotal = document.querySelector<HTMLElement>('[data-summary-total]');
const summaryPlan = document.querySelector<HTMLElement>('[data-summary-plan]');
const summaryDuration = document.querySelector<HTMLElement>('[data-summary-duration]');
const summaryMonthly = document.querySelector<HTMLElement>('[data-summary-monthly]');
const summaryFormat = document.querySelector<HTMLElement>('[data-summary-format]');
const summaryDiscount = document.querySelector<HTMLElement>('[data-summary-discount]');
const summaryBundle = document.querySelector<HTMLElement>('[data-summary-bundle]');
const placementSelect = form?.elements.namedItem('placement') as HTMLSelectElement | null;
const durationSelect = form?.elements.namedItem('duration') as HTMLSelectElement | null;
const textFields = document.getElementById('ads-text-fields');
const imageFields = document.getElementById('ads-image-fields');
const formError = document.querySelector<HTMLElement>('[data-error-for="form"]');
const copyTextarea = form?.querySelector<HTMLTextAreaElement>('textarea[name="copy"]');
const copyCount = document.querySelector<HTMLElement>('[data-copy-count]');
const statusPanel = document.getElementById('ads-order-status');

let csrfToken: string | null = null;

function selectedPlacement(): string {
  return placementSelect?.value ?? 'header';
}
function selectedDuration(): string {
  return durationSelect?.value ?? '1';
}
function selectedFormat(): string {
  const checked = form?.querySelector<HTMLInputElement>('input[name="format"]:checked');
  return checked?.value ?? 'text';
}

function updateSummary(): void {
  const placement = selectedPlacement();
  const duration = selectedDuration();
  const entry = priceTable[placement]?.[duration];
  if (!entry) return;

  // Rewrite each duration option label with the total for the current placement.
  if (durationSelect) {
    for (const opt of Array.from(durationSelect.options)) {
      const months = Number(opt.value);
      const e = priceTable[placement]?.[String(months)];
      if (e) opt.textContent = durationOptionLabel(months, e.total);
    }
  }

  if (summaryPlan) summaryPlan.textContent = placementLabels[placement] ?? placement;
  if (summaryDuration) {
    summaryDuration.textContent = `${duration} ${duration === '1' ? 'month' : 'months'}`;
  }
  if (summaryMonthly) summaryMonthly.textContent = `${money(entry.unit)}/mo`;
  if (summaryDiscount) {
    summaryDiscount.textContent = entry.discount > 0 ? `${entry.discount}% off` : '—';
  }
  if (summaryBundle) summaryBundle.hidden = placement !== 'fullsite';
  if (summaryTotal) summaryTotal.textContent = `${money(entry.total)} USD`;
  // Rebuild the whole button label (not just a span): textContent writes during
  // submit/CSRF states detach child nodes, so target the button itself.
  // Skipped while disabled so the "unavailable"/progress labels survive.
  if (submitButton && !submitButton.disabled) {
    submitButton.textContent = `Proceed to secure Stripe payment — ${money(entry.total)}`;
  }
}

function syncCreativeFormat(): void {
  const format = selectedFormat();
  const showingText = format === 'text';
  textFields?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((el) => {
    el.disabled = !showingText;
  });
  imageFields?.querySelectorAll<HTMLInputElement>('input').forEach((el) => {
    el.disabled = showingText;
  });
  if (textFields) textFields.hidden = !showingText;
  if (imageFields) imageFields.hidden = showingText;
  if (summaryFormat) summaryFormat.textContent = showingText ? 'Text' : 'Image';
}

function clearFieldErrors(): void {
  form?.querySelectorAll<HTMLElement>('.field-error').forEach((el) => {
    el.hidden = true;
    el.textContent = '';
  });
}

function showFieldErrors(errors: Record<string, string>): void {
  clearFieldErrors();
  for (const [field, message] of Object.entries(errors)) {
    const el = form?.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
    if (el) {
      el.textContent = message;
      el.hidden = false;
    } else {
      showFormError(message);
    }
  }
}

function showFormError(message: string): void {
  if (!formError) return;
  formError.textContent = message;
  formError.hidden = false;
}

async function loadCsrfToken(): Promise<void> {
  try {
    const res = await fetch('/api/ads/csrf');
    const data = (await res.json()) as { token?: string };
    if (!res.ok || !data.token) throw new Error('CSRF endpoint unavailable');
    csrfToken = data.token;
  } catch {
    csrfToken = null;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Ordering is temporarily unavailable';
    }
    showFormError(
      'Online ordering is not available right now. Please try again later, or reach out via the contact page and we will set up your campaign manually.',
    );
  }
}

async function submitOrder(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!form || !submitButton) return;
  if (!csrfToken) {
    showFormError('Please wait — securing the form, then try again.');
    await loadCsrfToken();
    return;
  }

  clearFieldErrors();
  submitButton.disabled = true;
  submitButton.textContent = 'Preparing your order…';

  try {
    const res = await fetch('/api/ads/orders', {
      method: 'POST',
      body: new FormData(form),
      headers: { 'X-CSRF-Token': csrfToken },
    });
    const data = (await res.json()) as {
      checkoutUrl?: string;
      orderId?: string;
      error?: string;
      fieldErrors?: Record<string, string>;
    };

    if (res.ok && data.checkoutUrl) {
      submitButton.textContent = 'Redirecting to Stripe…';
      window.location.href = data.checkoutUrl;
      return;
    }
    if (data.fieldErrors) showFieldErrors(data.fieldErrors);
    else showFormError(data.error || 'Your order could not be submitted. Please check the form and try again.');
  } catch {
    showFormError('A network error occurred. Please try again.');
  } finally {
    submitButton.disabled = false;
    // Restores the "Proceed to secure Stripe payment — $X" label with the
    // current total (textContent writes above replaced the original span).
    updateSummary();
  }
}

/* ---------- Return from Stripe Checkout ---------- */
async function pollOrderStatus(orderId: string): Promise<void> {
  if (!statusPanel) return;
  statusPanel.hidden = false;
  statusPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const title = statusPanel.querySelector<HTMLElement>('[data-status-title]');
  const note = statusPanel.querySelector<HTMLElement>('[data-status-note]');
  const details = statusPanel.querySelector<HTMLElement>('[data-status-details]');
  if (!title || !note) return;
  if (details) details.innerHTML = '';

  const fill = (rows: [string, string][]) => {
    if (!details) return;
    details.innerHTML = rows
      .map(([k, v]) => `<dt style="color: var(--color-muted);">${k}</dt><dd class="text-right font-semibold">${v}</dd>`)
      .join('');
  };

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`/api/ads/orders/${encodeURIComponent(orderId)}`);
      const data = (await res.json()) as {
        paymentStatus?: string;
        approvalStatus?: string;
        placementLabel?: string;
        durationMonths?: number;
        amountCents?: number;
      };
      if (res.ok && data.paymentStatus) {
        const total = typeof data.amountCents === 'number' ? money(data.amountCents / 100) : '';
        fill([
          ['Placement', data.placementLabel ?? ''],
          ['Duration', `${data.durationMonths ?? ''} month(s)`],
          ['Total', total],
          ['Payment', data.paymentStatus],
          ['Approval', data.approvalStatus ?? 'pending'],
        ]);
        if (data.paymentStatus === 'paid') {
          title.textContent = 'Payment confirmed — thank you!';
          note.textContent =
            'Your payment has been verified. Your creative is now pending advertising review, and you will receive a confirmation email. Campaigns start once the creative is approved and scheduled.';
          return;
        }
        if (data.paymentStatus === 'failed' || data.paymentStatus === 'expired' || data.paymentStatus === 'cancelled') {
          title.textContent = 'Payment did not complete';
          note.textContent =
            'No payment was taken. You can return to the order form and try again, or contact us if the problem persists.';
          return;
        }
        note.textContent = 'Payment received is still being confirmed by Stripe. This can take a few seconds.';
      }
    } catch {
      /* keep polling; the order may not be queryable yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  title.textContent = 'Confirmation is taking longer than usual';
  note.textContent =
    'If you completed payment, your order is safe — confirmation may still be processing. You will receive an email once your payment and creative are reviewed. No need to submit the order again.';
}

function init(): void {
  if (!form) return;

  form.addEventListener('submit', submitOrder);
  form.querySelector('select[name="placement"]')?.addEventListener('change', updateSummary);
  form.querySelector('select[name="duration"]')?.addEventListener('change', updateSummary);
  form.querySelectorAll('input[name="format"]').forEach((input) => input.addEventListener('change', syncCreativeFormat));

  copyTextarea?.addEventListener('input', () => {
    if (copyCount) copyCount.textContent = String(copyTextarea.value.length);
  });

  syncCreativeFormat();
  updateSummary();
  void loadCsrfToken();

  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('order');
  if (orderId) {
    if (params.get('status') === 'cancelled') showCancelledOrder(orderId);
    else void pollOrderStatus(orderId);
  }
}

function showCancelledOrder(orderId: string): void {
  if (!statusPanel) return;
  const title = statusPanel.querySelector<HTMLElement>('[data-status-title]');
  const note = statusPanel.querySelector<HTMLElement>('[data-status-note]');
  if (title && note) {
    title.textContent = 'Payment cancelled';
    note.textContent =
      'You closed the Stripe checkout before paying, so no payment was taken. Your order details are saved — return to the form below to try again whenever you are ready.';
  }
  statusPanel.hidden = false;
  statusPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

init();
