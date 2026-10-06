// #1108 stage 2 — the gate on **Save & Pay → Pending Payment → Active**.
//
// The lifecycle lives in places that cannot see each other, and most of them fail
// *silently* when they drift:
//
//  * the CHECK (migration 233) and `STATUSES` — a value in one and not the other
//    either makes every Save & Pay fail with a constraint violation, or lets a
//    status through that no route knows;
//  * the two editing allowlists — `pending_payment` reaching either would let
//    staff change the configuration the member is already being charged for, and
//    nothing at runtime notices, because the edit saves perfectly well;
//  * the webhook — without its commit a member is charged and their plan stays
//    Pending Payment for ever, which looks exactly like an abandoned checkout;
//  * the provider call's position — made inside the transaction, or after the
//    status flip, it turns a provider outage into a locked plan with no charge;
//  * the admin's two halves — a Member window with no action area is a Draft
//    nobody can commit, and a missing locale key renders as the key itself,
//    because next-intl has no fallback.
//
// It lives in the API suite because CI runs `npm test` in `api/` only, which is
// also why it reaches into the admin app's sources (#1009's reason).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DRAFT_ASSIGNMENT_STATUS,
  PENDING_PAYMENT_ASSIGNMENT_STATUS,
  PRE_ACTIVATION_STATUSES,
  excludePreActivationSql,
  isConfigurableAssignmentStatus,
  isPreActivationStatus,
  preActivationLockReason,
} from '../domain/assignmentCommit';

const API_SRC = join(__dirname, '..');
const REPO = join(API_SRC, '..', '..');
const ADMIN_SRC = join(REPO, 'apps', 'admin', 'src');
const ADMIN_LOCALES = join(REPO, 'apps', 'admin', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

/** A source with `//` and block comments stripped, so a rule is asserted against code. */
function code(...parts: string[]): string {
  return read(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const USER_MEMBERSHIPS = code(API_SRC, 'api', 'user-memberships.ts');
const COMMIT = code(API_SRC, 'api', 'assignment-commit.ts');
const WEBHOOKS = code(API_SRC, 'api', 'webhooks.ts');
const PAYMENT_REQUEST = code(API_SRC, 'api', 'membership-fee-payment-request.ts');

describe('the pre-activation vocabulary', () => {
  it('is the two statuses, and says which of them may still be configured', () => {
    expect([...PRE_ACTIVATION_STATUSES]).toEqual(['draft', 'pending_payment']);
    expect(isPreActivationStatus(DRAFT_ASSIGNMENT_STATUS)).toBe(true);
    expect(isPreActivationStatus(PENDING_PAYMENT_ASSIGNMENT_STATUS)).toBe(true);
    expect(isPreActivationStatus('active')).toBe(false);
    expect(isPreActivationStatus(undefined)).toBe(false);

    // A Draft is configurable (§2); a Pending Payment is the point of no return
    // (§6). Nothing else is this question's business — an `active` assignment is
    // editable under the snapshot rules and answers false here.
    expect(isConfigurableAssignmentStatus(DRAFT_ASSIGNMENT_STATUS)).toBe(true);
    expect(isConfigurableAssignmentStatus(PENDING_PAYMENT_ASSIGNMENT_STATUS)).toBe(false);
    expect(isConfigurableAssignmentStatus('active')).toBe(false);
  });

  it('gives exactly one status a lock reason, and it names the way out', () => {
    const reason = preActivationLockReason(PENDING_PAYMENT_ASSIGNMENT_STATUS);
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/locked/i);
    // Closing it is the way out — there is no `pending_payment -> draft`.
    expect(reason).toMatch(/close/i);
    expect(preActivationLockReason(DRAFT_ASSIGNMENT_STATUS)).toBeNull();
    expect(preActivationLockReason('active')).toBeNull();
    expect(preActivationLockReason(undefined)).toBeNull();
  });

  it('excludes both statuses in SQL, with no bound parameters', () => {
    expect(excludePreActivationSql('um')).toBe("um.status NOT IN ('draft', 'pending_payment')");
    expect(excludePreActivationSql('x')).toContain('x.status');
    // Its two callers interpolate it into statements whose parameter lists are
    // built elsewhere, so a `?` here would silently consume one of theirs.
    expect(excludePreActivationSql()).not.toContain('?');
  });
});

describe('migration 233 and the router agree on what may be stored', () => {
  const MIGRATION = read(API_SRC, 'infra', 'migrations', '233_pending_payment_membership_status.js');

  it('widens the CHECK by exactly Pending Payment', () => {
    const wide = [...(MIGRATION.match(/const WIDE = \[([^\]]*)\]/)?.[1] ?? '')
      .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const narrow = [...(MIGRATION.match(/const NARROW = \[([^\]]*)\]/)?.[1] ?? '')
      .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(narrow).toEqual(['draft', 'active', 'paused', 'cancelled', 'expired']);
    // `WIDE` is written as `['pending_payment', ...NARROW]`, which is what makes
    // the two sets impossible to drift apart by editing one of them.
    expect(MIGRATION).toMatch(/const WIDE = \['pending_payment', \.\.\.NARROW\]/);
    expect(wide).toEqual(['pending_payment']);
  });

  it('refuses to narrow while a row holds a value the narrow CHECK would reject', () => {
    // The row guard is 227's and 198's, for their reason: the ADD CONSTRAINT runs
    // after the DROP CHECK has committed, so a failure leaves the table with no
    // status CHECK at all.
    expect(MIGRATION).toMatch(/status NOT IN \(\$\{marks\}\)/);
    expect(MIGRATION).toContain('Nothing has been touched.');
  });

  it('does not revive the retired awaiting_payment spelling', () => {
    expect(MIGRATION.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('awaiting_payment');
    expect(USER_MEMBERSHIPS).not.toContain('awaiting_payment');
  });
});

describe('Save & Pay', () => {
  it('is one route, and the admin\'s single completion action', () => {
    expect(USER_MEMBERSHIPS).toMatch(/post\('\/:id\/save-and-pay'/);
    expect([...USER_MEMBERSHIPS.matchAll(/post\('\/:id\/save-and-pay'/g)]).toHaveLength(1);
  });

  it('calls the provider before anything is written, and writes the charge and the lock together', () => {
    const route = USER_MEMBERSHIPS.slice(USER_MEMBERSHIPS.indexOf("post('/:id/save-and-pay'"));
    const provider = route.indexOf('createMembershipFeeProviderOrder');
    const insert = route.indexOf('insertMembershipFeePaymentRequest');
    const lock = route.indexOf('lockAssignmentForPayment');
    expect(provider).toBeGreaterThan(-1);
    // A provider that throws must leave a Draft a Draft, so the call precedes
    // every write.
    expect(provider).toBeLessThan(insert);
    expect(provider).toBeLessThan(lock);
    // And the row and the status move in one transaction, so there is never a
    // charge with no lock or a lock with no charge.
    const tx = route.lastIndexOf('db.transaction', insert);
    expect(tx).toBeGreaterThan(-1);
    expect(tx).toBeLessThan(lock);
  });

  it('commits outright when the first cycle owes nothing, rather than raising a €0 charge', () => {
    const route = USER_MEMBERSHIPS.slice(USER_MEMBERSHIPS.indexOf("post('/:id/save-and-pay'"));
    expect(route).toMatch(/if \(!\(fee > 0\)\)/);
    const zero = route.indexOf('if (!(fee > 0))');
    const commit = route.indexOf('commitAssignment', zero);
    const provider = route.indexOf('createMembershipFeeProviderOrder');
    expect(commit).toBeGreaterThan(zero);
    // The commit for a free first cycle happens before the provider is ever
    // reached: a zero-amount order would put a €0 payment in the member's own
    // history (#788's reason for keeping verifications out of it).
    expect(commit).toBeLessThan(provider);
  });

  it('prices the charge through the one fee resolver and never a second arithmetic', () => {
    const route = USER_MEMBERSHIPS.slice(USER_MEMBERSHIPS.indexOf("post('/:id/save-and-pay'"));
    expect(route).toContain('currentMembershipFee(');
    expect(route).not.toMatch(/\* *1\.21|\/ *1\.21/);
  });

  it('surfaces #956\'s replacement as a 409 before the member is asked for money', () => {
    const route = USER_MEMBERSHIPS.slice(USER_MEMBERSHIPS.indexOf("post('/:id/save-and-pay'"));
    const conflict = route.indexOf('activePlanConflictBody');
    const provider = route.indexOf('createMembershipFeeProviderOrder');
    expect(conflict).toBeGreaterThan(-1);
    expect(conflict).toBeLessThan(provider);
    // And it supersedes nothing itself: the cancellation is the commit's, so an
    // abandoned checkout leaves the member's current plan exactly as it was.
    expect(route.slice(0, provider)).not.toContain('supersedeLiveAssignments');
  });

  it('expires the previous pending charge rather than leaving two live orders', () => {
    const route = USER_MEMBERSHIPS.slice(USER_MEMBERSHIPS.indexOf("post('/:id/save-and-pay'"));
    expect(route).toMatch(/UPDATE payment_requests SET status = 'expired'/);
  });
});

describe('the commit is one place, with three callers', () => {
  it('lives in assignment-commit.ts and moves a row out of either pre-activation status', () => {
    expect(COMMIT).toContain('export async function commitAssignment');
    expect(COMMIT).toMatch(/SET status = 'active'[\s\S]*?status IN \(\$\{statusMarks\}\)/);
    expect(COMMIT).toContain('PRE_ACTIVATION_STATUSES');
  });

  it('is what the activation route, Save & Pay and the webhook all call', () => {
    for (const source of [USER_MEMBERSHIPS, WEBHOOKS]) {
      expect(source).toContain('commitAssignment');
    }
    // Two callers in the router: the activation route and Save & Pay's free-cycle
    // branch.
    expect([...USER_MEMBERSHIPS.matchAll(/commitAssignment\(tx/g)].length).toBeGreaterThanOrEqual(2);
  });

  it('writes no second UPDATE of the status anywhere else', () => {
    // A second `-> active` write would bypass #956's check and the supersede.
    const flips = [...USER_MEMBERSHIPS.matchAll(/SET status = 'active'/g)];
    expect(flips).toHaveLength(0);
  });

  it('asks #956\'s question for every Member the assignment covers', () => {
    expect(COMMIT).toContain('user_membership_members');
    expect(COMMIT).toContain('excludeUserMembershipId');
  });
});

describe('the payment webhook activates what it paid for', () => {
  it('commits inside the transaction that records the payment', () => {
    const branch = WEBHOOKS.slice(WEBHOOKS.indexOf("payload.status === 'completed') {"));
    const commit = branch.indexOf('commitAssignment');
    expect(commit).toBeGreaterThan(-1);
    const tx = branch.lastIndexOf('db.transaction', commit);
    expect(tx).toBeGreaterThan(-1);
    // `confirm: true`: by the time this runs the member has paid, and refusing to
    // activate a membership somebody has been charged for would leave money taken
    // for a plan that never started.
    expect(branch.slice(commit, commit + 400)).toContain('confirm: true');
  });

  it('does not activate from the card-update or product-purchase branches', () => {
    // A card verification settles no cycle and a Product purchase is not a
    // membership, so neither may commit an assignment.
    const cardBranch = WEBHOOKS.slice(
      WEBHOOKS.indexOf('pr.source === CARD_UPDATE_SOURCE'),
      WEBHOOKS.indexOf('pr.source === PRODUCT_PURCHASE_SOURCE'),
    );
    expect(cardBranch).not.toContain('commitAssignment');
  });
});

describe('a Pending Payment is locked', () => {
  it('is refused by PUT /:id with the lock reason rather than a status list', () => {
    expect(USER_MEMBERSHIPS).toContain('preActivationLockReason(current[0].status)');
    expect(USER_MEMBERSHIPS).toMatch(/kind: 'locked'/);
  });

  it('is refused by the promotion apply and revoke paths', () => {
    const promotions = code(API_SRC, 'api', 'membership-promotions.ts');
    expect([...promotions.matchAll(/preActivationLockReason\(/g)].length).toBeGreaterThanOrEqual(3);
  });

  it('is refused by the Additional Products attach path', () => {
    expect(code(API_SRC, 'api', 'user-membership-services.ts'))
      .toContain('preActivationLockReason(plan.status)');
  });

  it('is still projected, so the Billing Event Forecast keeps answering for it', () => {
    const simulation = code(API_SRC, 'api', 'billing-simulation.ts');
    const match = simulation.match(/const SIMULATED_STATUSES = \[([^\]]*)\]/);
    expect([...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toContain('pending_payment');
  });

  it('is still shown on the Member card\'s own configuration read', () => {
    const configuration = code(API_SRC, 'api', 'member-membership-configuration.ts');
    const match = configuration.match(/const LIVE_STATUSES = \[([^\]]*)\]/);
    expect([...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toContain('pending_payment');
  });

  it('bills nothing and books nothing, because both still read `active` only', () => {
    expect(code(API_SRC, 'api', 'billing.ts')).toContain("WHERE um.status = 'active'");
    const loader = code(API_SRC, 'domain', 'memberProfessionalServices.ts');
    expect(loader).toContain("um.status = 'active'");
  });
});

describe('one place raises a Membership Fee payment', () => {
  it('holds the provider call, the token TTL and the INSERT', () => {
    expect(PAYMENT_REQUEST).toContain('export async function createMembershipFeeProviderOrder');
    expect(PAYMENT_REQUEST).toContain('export async function insertMembershipFeePaymentRequest');
    expect(PAYMENT_REQUEST).toContain('PAGE_TOKEN_TTL_MS');
    // The euro -> minor-units conversion is here, so a fourth caller cannot pass
    // euros to a provider that expects cents (CLAUDE.md's rule).
    expect(PAYMENT_REQUEST).toContain('toMinorUnits');
  });

  it('is what all three callers use, and none of them builds a provider order itself', () => {
    const callers = [
      code(API_SRC, 'api', 'payment-requests.ts'),
      code(API_SRC, 'api', 'me.ts'),
      USER_MEMBERSHIPS,
    ];
    for (const caller of callers) {
      expect(caller).toContain('createMembershipFeeProviderOrder');
      expect(caller).toContain('insertMembershipFeePaymentRequest');
      expect(caller).not.toContain('createPaymentRequest({');
      expect(caller).not.toMatch(/INSERT INTO payment_requests/);
    }
  });
});

describe('the Member window\'s action area', () => {
  const LIB = code(ADMIN_SRC, 'lib', 'saveAndPay.ts');
  const VIEW = code(ADMIN_SRC, 'components', 'members', 'MemberSaveAndPayActions.tsx');
  const SECTION = code(ADMIN_SRC, 'app', '[locale]', 'members', 'MemberSaveAndPaySection.tsx');
  const PAGE = code(ADMIN_SRC, 'app', '[locale]', 'members', 'page.tsx');

  it('is rendered by the Member card outside its tab panes (§7)', () => {
    expect(PAGE).toContain('MemberSaveAndPaySection');
    const tabs = PAGE.indexOf('<MemberExpandedRow');
    expect(PAGE.indexOf('<MemberSaveAndPaySection')).toBeGreaterThan(tabs);
  });

  it('decides what it offers in one JSX-free module, which resolves no t() and no money', () => {
    expect(LIB).toContain('export function saveAndPayMode');
    expect(LIB).not.toMatch(/useTranslations|\bt\(/);
    expect(LIB).not.toContain('apiFetch');
    // The view draws and resolves nothing either.
    expect(VIEW).not.toMatch(/useTranslations/);
    expect(VIEW).not.toContain('apiFetch');
    // No hex: the action is the Theme's primary button (#912/#954).
    expect(VIEW).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(VIEW).toContain('primaryBtnStyle()');
  });

  it('renders nothing at all when there is nothing to commit', () => {
    expect(VIEW).toMatch(/mode === 'none'\) return null/);
    expect(SECTION).toMatch(/mode === 'none'\) return null/);
  });

  it('never passes its handler by reference, so a click cannot confirm a replacement', () => {
    // #956's own rule: the `MouseEvent` would land in `confirmReplacement`.
    expect(SECTION).toContain('onAction={() => void submit()}');
    expect(SECTION).not.toMatch(/onAction=\{submit\}/);
    expect(SECTION).toContain('ReplacePlanDialog');
  });

  it('is called Save & Pay and never Save, in every locale', () => {
    for (const locale of LOCALE_CODES) {
      const messages = JSON.parse(read(ADMIN_LOCALES, `${locale}.json`));
      const label = messages.members?.save_and_pay as string | undefined;
      expect(label, locale).toBeTruthy();
      // §6 — "Do not call this button Save".
      expect(label!.trim().toLowerCase(), locale).not.toBe('save');
      for (const key of [
        'section_save_and_pay', 'save_and_pay_new_link', 'save_and_pay_draft_notice',
        'save_and_pay_awaiting_notice', 'save_and_pay_amount', 'save_and_pay_nothing_due',
        'save_and_pay_open_link', 'save_and_pay_copy_link', 'save_and_pay_link_copied',
        'save_and_pay_copy_failed', 'save_and_pay_link_expired', 'save_and_pay_error',
      ]) {
        expect(messages.members?.[key], `${locale}.${key}`).toBeTruthy();
      }
    }
  });
});
