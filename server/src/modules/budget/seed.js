// Demo data for the Rivera family: ~6 months of realistic spending (richest in the last 2),
// monthly limits, recurring bills (auto + manual), savings goals and kids' allowances.
import { addMonths, dateKey, daysInMonth, dueDate, ensureDefaults, familyToday, generateDue, monthOf, recordBillPayment } from './lib.js';

/** Small deterministic PRNG so the demo looks the same on every seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIMITS = {
  Groceries: 1250, Housing: 2200, Utilities: 400, Transport: 340, Kids: 480, Health: 160,
  Dining: 300, Entertainment: 220, Shopping: 550, Savings: 300,
};

function receiptSvg(store, lines, total, date) {
  const rows = lines
    .map(([label, price], i) => `<text x="24" y="${118 + i * 26}" font-size="15">${label}</text><text x="296" y="${118 + i * 26}" font-size="15" text-anchor="end">${price}</text>`)
    .join('');
  const h = 190 + lines.length * 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${h}" viewBox="0 0 320 ${h}" font-family="Courier New, monospace" fill="#222">
<rect width="320" height="${h}" fill="#fffdf6"/>
<text x="160" y="44" font-size="20" font-weight="bold" text-anchor="middle">${store}</text>
<text x="160" y="68" font-size="13" text-anchor="middle" fill="#666">${date}</text>
<line x1="24" y1="88" x2="296" y2="88" stroke="#bbb" stroke-dasharray="4 4"/>
${rows}
<line x1="24" y1="${h - 72}" x2="296" y2="${h - 72}" stroke="#bbb" stroke-dasharray="4 4"/>
<text x="24" y="${h - 44}" font-size="17" font-weight="bold">TOTAL</text><text x="296" y="${h - 44}" font-size="17" font-weight="bold" text-anchor="end">${total}</text>
<text x="160" y="${h - 16}" font-size="12" text-anchor="middle" fill="#888">Thank you for shopping!</text>
</svg>`;
}

export async function seed(ctx, { familyId, users }) {
  const { db } = ctx;
  const { alex, sam, mia, leo } = users;
  ensureDefaults(db, familyId);
  const cat = Object.fromEntries(db.prepare('SELECT id, name FROM budget_categories WHERE family_id = ?').all(familyId).map((c) => [c.name, c.id]));
  const setLimit = db.prepare('UPDATE budget_categories SET limit_cents = ? WHERE id = ?');
  for (const [name, limit] of Object.entries(LIMITS)) setLimit.run(limit * 100, cat[name]);

  const today = familyToday(ctx, familyId); // the family's day, not the server's (UTC) one
  const thisMonth = monthOf(today);
  const firstMonth = addMonths(thisMonth, -5);
  const rand = rng(20260929);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100); // cents
  const createdAt = (date) => `${date}T${String(8 + Math.floor(rand() * 12)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00.000Z`;

  const insertTx = db.prepare(
    `INSERT INTO budget_transactions (family_id, kind, amount_cents, category_id, description, date, paid_by, notes, receipt_url, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const add = (date, kind, cents, category, description, paidBy, { notes = null, receipt = null } = {}) => {
    if (date > today) return null;
    const at = createdAt(date);
    return Number(insertTx.run(familyId, kind, cents, category ? cat[category] : null, description, date, paidBy.id, notes, receipt, paidBy.id, at, at).lastInsertRowid);
  };
  const day = (month, d) => `${month}-${String(Math.min(d, daysInMonth(month))).padStart(2, '0')}`;
  // N days before today (so recent demo items exist whatever day of the month you seed on).
  const daysAgo = (n) => {
    const t = new Date(`${today}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() - n);
    return t.toISOString().slice(0, 10);
  };

  db.exec('BEGIN');
  try {
    // ---- recurring bills -------------------------------------------------------------------
    const billStart = `${firstMonth}-01T07:00:00.000Z`;
    const insertBill = db.prepare(
      `INSERT INTO budget_recurring (family_id, kind, description, amount_cents, category_id, day_of_month, paid_by, auto_create, start_month, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const bill = (kind, description, amount, category, dom, paidBy, auto, notes = null) => {
      const id = Number(insertBill.run(familyId, kind, description, Math.round(amount * 100), cat[category], dom, paidBy?.id ?? null, auto ? 1 : 0, firstMonth, notes, alex.id, billStart).lastInsertRowid);
      return db.prepare('SELECT * FROM budget_recurring WHERE id = ?').get(id);
    };
    bill('income', "Alex's salary", 5400, 'Salary', 1, alex, true, 'Direct deposit from Brightline Studio');
    bill('expense', 'Mortgage', 2150, 'Housing', 1, alex, true, 'Autopay from joint checking');
    bill('expense', 'Netflix', 15.49, 'Entertainment', 7, sam, true);
    bill('expense', 'Internet — Sonic Fiber', 69.99, 'Utilities', 12, alex, true);
    bill('expense', 'College fund transfer', 300, 'Savings', 15, alex, true, "Mia & Leo's 529 plans");
    bill('expense', 'Phone plan', 95, 'Utilities', 18, sam, true);
    bill('expense', 'Spotify Family', 16.99, 'Entertainment', 22, sam, true);
    const carInsurance = bill('expense', 'Car insurance', 142, 'Transport', 5, alex, false);
    const piano = bill('expense', "Leo's piano lessons", 120, 'Kids', 3, sam, false, 'Ms. Delgado — pay by Venmo');
    const electric = bill('expense', 'Electric bill — Austin Energy', 135, 'Utilities', 20, alex, false, 'Amount varies with the season');
    const water = bill('expense', 'Water & trash', 54, 'Utilities', 30, sam, false);
    const soccer = bill('expense', 'Soccer club dues', 85, 'Kids', 10, sam, false, "Mia's U12 team");

    // Auto bills: the same engine the server uses fills in every past month.
    generateDue(db, familyId, today, ctx.time.familyTz(familyId));

    // Manual bills: paid for past months; this month is a mix of paid / overdue / upcoming.
    for (let m = firstMonth; m <= thisMonth; m = addMonths(m, 1)) {
      const past = m < thisMonth;
      const pay = (b, amount, dayOffset = 0, who = null) => {
        const due = dueDate(m, b.day_of_month);
        const [y, mo, d] = due.split('-').map(Number);
        const paidDate = dateKey(new Date(y, mo - 1, d + dayOffset));
        if (paidDate > today) return;
        recordBillPayment(db, b, m, { amountCents: Math.round(amount * 100), date: paidDate, userId: (who ?? alex).id, paidBy: who ? who.id : undefined });
      };
      pay(carInsurance, 142, -1);
      pay(piano, 120, 0, sam);
      pay(soccer, 85, 1, sam);
      const summer = ['06', '07', '08'].includes(m.slice(5));
      if (past) {
        pay(electric, summer ? 158 + rand() * 30 : 112 + rand() * 25, 2);
        pay(water, 54, 0, sam);
      }
    }
    // Make sure this month's electric bill is overdue (not paid) and water is upcoming — handled above.

    // ---- day-to-day spending --------------------------------------------------------------
    const grocers = [
      ["Trader Joe's", 68, 145], ['Costco run', 160, 260], ['Farmers market', 28, 55], ['Safeway', 45, 120], ['Whole Foods', 52, 110],
    ];
    const dining = [
      ["Pizza night — Tony's", 38, 52], ['Sunday brunch at Bluebird', 62, 88], ['Coffee & pastries', 11, 19], ['Sushi takeout', 48, 72],
      ['Ice cream after soccer', 14, 22], ['Tacos El Gordo', 26, 38], ['Burger night', 44, 60],
    ];
    const fun = [['Movie night — AMC', 42, 58], ['Zoo tickets', 64, 64], ['Mini golf', 36, 44], ['New board game', 29, 45], ['Bowling', 48, 62]];
    const shops = [['Target', 35, 110], ['Amazon — household', 22, 85], ['IKEA', 60, 180], ["Kids' shoes", 48, 90], ['Home Depot', 25, 95]];
    const gas = ['Shell', 'Chevron', 'Costco gas'];

    for (let m = firstMonth; m <= thisMonth; m = addMonths(m, 1)) {
      const recent = m >= addMonths(thisMonth, -2);
      const isThis = m === thisMonth;
      // Groceries roughly every 3–5 days.
      for (let d = 2; d <= 31; d += 3 + Math.floor(rand() * 3)) {
        const [label, lo, hi] = pick(grocers);
        add(day(m, d), 'expense', between(lo, hi), 'Groceries', label, rand() < 0.55 ? sam : alex);
      }
      // Dining out — this month runs over budget.
      const diningCount = isThis ? 8 : recent ? 6 : 4;
      for (let i = 0; i < diningCount; i++) {
        const [label, lo, hi] = pick(dining);
        add(day(m, 2 + Math.floor(rand() * 27)), 'expense', between(lo, hi) + (isThis ? 900 : 0), 'Dining', label, pick([alex, sam, sam]));
      }
      // Gas.
      for (let i = 0; i < 3; i++) add(day(m, 4 + i * 9 + Math.floor(rand() * 4)), 'expense', between(42, 66), 'Transport', `Gas — ${pick(gas)}`, pick([alex, sam]));
      if (recent) add(day(m, 17), 'expense', between(12, 18), 'Transport', 'Car wash', alex);
      // Fun + shopping.
      for (let i = 0; i < (recent ? 3 : 2); i++) {
        const [label, lo, hi] = pick(fun);
        add(day(m, 3 + Math.floor(rand() * 26)), 'expense', between(lo, hi), 'Entertainment', label, pick([alex, sam]));
      }
      for (let i = 0; i < (recent ? 3 : 2); i++) {
        const [label, lo, hi] = pick(shops);
        add(day(m, 3 + Math.floor(rand() * 26)), 'expense', between(lo, hi), 'Shopping', label, pick([alex, sam]));
      }
      // Health.
      add(day(m, 8 + Math.floor(rand() * 15)), 'expense', between(12, 38), 'Health', 'Pharmacy — CVS', sam);
      // Kids extras.
      add(day(m, 6 + Math.floor(rand() * 20)), 'expense', between(15, 32), 'Kids', pick(['Birthday gift for a classmate', 'Art supplies', 'Book fair', 'Swim goggles']), sam);
      // Other.
      if (rand() < 0.7) add(day(m, 12 + Math.floor(rand() * 10)), 'expense', between(45, 70), 'Other', 'Haircuts', alex);
      // Sam's freelance design work.
      add(day(m, 9 + Math.floor(rand() * 6)), 'income', between(850, 1650), 'Side income', pick(['Logo design — Riverbend Bakery', 'Website refresh — Oak Dental', 'Brochure for Parks & Rec', 'Illustrations — Little Owl Books']), sam);
    }

    // "This month runs over budget" must hold whatever day of the month the demo is seeded on
    // (early in a month most of the dining dates above are still in the future and skipped).
    {
      const spent = db.prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) AS c FROM budget_transactions WHERE family_id = ? AND category_id = ? AND kind = 'expense' AND date >= ? AND date <= ?",
      ).get(familyId, cat.Dining, `${thisMonth}-01`, today).c;
      const limit = LIMITS.Dining * 100;
      if (spent <= limit) add(today, 'expense', limit - spent + 38_40, 'Dining', 'Anniversary dinner — Bella Vista', alex, { notes: 'Worth it 🥂' });
    }

    // A few memorable one-offs in the last two months.
    const prev = addMonths(thisMonth, -1);
    add(day(prev, 11), 'expense', 45_00, 'Health', 'Dentist copay — Mia', sam, { notes: 'Cleaning + sealants. Next visit in March.' });
    add(day(prev, 19), 'expense', 186_40, 'Kids', 'Back-to-school supplies', sam, { notes: 'Backpacks, binders, calculators for both kids' });
    add(day(prev, 24), 'income', 120_00, 'Gifts & refunds', 'Sold the old stroller', alex);
    add(day(prev, 27), 'expense', 32_00, 'Kids', 'Field trip — Science museum', alex);
    add(day(thisMonth, 2), 'expense', 60_00, 'Kids', "Leo's swim lessons", sam);
    add(day(thisMonth, 6), 'expense', 6_50, 'Dining', 'Snacks at the pool', mia);
    add(day(thisMonth, 13), 'expense', 12_99, 'Entertainment', 'Comic books', leo);
    add(day(thisMonth, 14), 'income', 412_00, 'Gifts & refunds', 'Tax refund (state)', alex);
    add(day(thisMonth, 21), 'expense', 74_20, 'Health', 'Pediatrician copay + prescription', sam);

    // Receipts (generated SVG images) on a couple of recent purchases.
    const attach = (date, store, lines, totalCents, category, desc, who) => {
      if (date > today) return;
      const svg = receiptSvg(store, lines, `$${(totalCents / 100).toFixed(2)}`, date);
      const url = ctx.storeFile(familyId, Buffer.from(svg), 'svg');
      add(date, 'expense', totalCents, category, desc, who, { receipt: url });
    };
    attach(daysAgo(2), 'COSTCO WHOLESALE', [['Kirkland eggs 24ct', '6.99'], ['Organic milk x3', '14.49'], ['Chicken thighs', '18.72'], ['Berries 2lb', '8.99'], ['Paper towels', '22.99'], ['Coffee beans', '17.99']], 90_17, 'Groceries', 'Costco — weekly stock-up', alex);
    attach(daysAgo(9), 'TARGET', [['Mia — rain jacket', '34.99'], ['Leo — sneakers', '39.99'], ['Lunch boxes x2', '19.98']], 94_96, 'Shopping', 'Target — fall clothes', sam);

    // ---- savings goals ---------------------------------------------------------------------
    const insertGoal = db.prepare(
      'INSERT INTO budget_goals (family_id, name, emoji, color, target_cents, owner_id, target_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertEntry = db.prepare(
      'INSERT INTO budget_goal_entries (goal_id, family_id, amount_cents, note, source, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
    const goal = (name, emoji, color, target, owner, targetDate, createdBy, entries) => {
      const id = Number(insertGoal.run(familyId, name, emoji, color, target * 100, owner?.id ?? null, targetDate, createdBy.id, ago(150)).lastInsertRowid);
      for (const [cents, note, source, who, daysAgo] of entries) insertEntry.run(id, familyId, cents, note, source, who.id, ago(daysAgo));
      return id;
    };
    const nextYear = Number(thisMonth.slice(0, 4)) + 1;
    goal('Summer trip to Lake Tahoe', '🏕️', '#0090FF', 3000, null, `${nextYear}-06-20`, alex, [
      [800_00, 'Starting balance', 'manual', alex, 140], [300_00, 'May savings', 'manual', alex, 120], [250_00, null, 'manual', sam, 90],
      [300_00, 'Freelance bonus', 'manual', sam, 60], [190_00, null, 'manual', alex, 25],
    ]);
    goal('Emergency fund', '🛟', '#30A46C', 10000, null, null, alex, [
      [5000_00, 'Starting balance', 'manual', alex, 148], [400_00, null, 'manual', alex, 110], [400_00, null, 'manual', alex, 80],
      [400_00, null, 'manual', alex, 50], [-150_00, 'Fridge repair', 'manual', sam, 35], [400_00, null, 'manual', alex, 20],
    ]);
    const bike = goal('New bike', '🚲', '#30A46C', 240, mia, `${thisMonth.slice(0, 4)}-12-20`, mia, [
      [60_00, 'Birthday money from Grandma', 'manual', mia, 100], [10_00, 'Weekly allowance', 'allowance', alex, 30], [10_00, 'Weekly allowance', 'allowance', alex, 23],
      [25_00, 'Lemonade stand', 'manual', mia, 20], [10_00, 'Weekly allowance', 'allowance', alex, 16], [10_00, 'Weekly allowance', 'allowance', alex, 9],
      [21_00, 'Pet-sitting for the Nguyens', 'manual', mia, 5], [10_00, 'Weekly allowance', 'allowance', alex, 2],
    ]);
    const lego = goal('LEGO space shuttle', '🚀', '#F76B15', 80, leo, null, leo, [
      [20_00, 'Tooth fairy savings', 'manual', leo, 60], [5_00, 'Weekly allowance', 'allowance', sam, 30], [5_00, 'Weekly allowance', 'allowance', sam, 23],
      [5_00, 'Weekly allowance', 'allowance', sam, 16], [10_00, 'Helped wash the car', 'manual', leo, 12], [5_00, 'Weekly allowance', 'allowance', sam, 9],
      [5_00, 'Weekly allowance', 'allowance', sam, 2],
    ]);
    const done = goal('New couch', '🛋️', '#8E4EC6', 900, null, null, sam, [[500_00, null, 'manual', sam, 140], [400_00, null, 'manual', alex, 70]]);
    db.prepare('UPDATE budget_goals SET completed_at = ? WHERE id = ?').run(ago(70), done);

    // ---- allowances ----------------------------------------------------------------------
    const insertAllowance = db.prepare(
      'INSERT INTO budget_allowances (family_id, member_id, amount_cents, frequency, goal_id, last_paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertAllowance.run(familyId, mia.id, 10_00, 'weekly', bike, ago(2), ago(40));
    insertAllowance.run(familyId, leo.id, 5_00, 'weekly', lego, ago(2), ago(40));

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // ---- wall activity (backdated) -----------------------------------------------------------
  const log = (userId, verb, summary, link, daysAgo) =>
    ctx.logActivity({ familyId, userId, module: 'budget', verb, summary, link, createdAt: new Date(Date.now() - daysAgo * 864e5).toISOString() });
  log(mia.id, 'goal', 'started saving for 🚲 New bike · $240.00', '/budget/goals', 20);
  log(sam.id, 'paid', `paid Leo's piano lessons · $120.00`, '/budget/bills', 12);
  log(alex.id, 'saved', 'added $190.00 to 🏕️ Summer trip to Lake Tahoe', '/budget/goals', 6);
  log(alex.id, 'allowance', "paid Mia's allowance · $10.00 → New bike", '/budget/goals', 2);
}
