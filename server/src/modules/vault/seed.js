// Demo content for the Rivera family: contacts, folders, generated documents (real PDFs, SVG
// "scans", text/CSV files — no network) and info cards.
import { extOf, writeVaultFile } from './files.js';

// ---- tiny file generators -------------------------------------------------------------------

const ascii = (s) => s.normalize('NFKD').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e]/g, '');
const pdfText = (s) => ascii(s).replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * A real one-page PDF (Letter) with a coloured header band, title, subtitle and body lines.
 * `lines` entries: string, or { text, bold, size, gap } ; '' for a blank line.
 */
export function makePdf({ title, subtitle = '', color = [0.36, 0.36, 0.84], lines = [] }) {
  const [r, g, b] = color;
  const ops = [];
  ops.push(`${r} ${g} ${b} rg 0 692 612 100 re f`);
  ops.push(`1 1 1 rg BT /F2 24 Tf 54 740 Td (${pdfText(title)}) Tj ET`);
  if (subtitle) ops.push(`1 1 1 rg BT /F1 12 Tf 54 716 Td (${pdfText(subtitle)}) Tj ET`);
  let y = 650;
  for (const line of lines) {
    const l = typeof line === 'string' ? { text: line } : line;
    const size = l.size ?? 11;
    if (l.rule) {
      ops.push(`0.85 0.85 0.9 RG 1 w 54 ${y + 6} m 558 ${y + 6} l S`);
      y -= 14;
      continue;
    }
    if (l.text) ops.push(`0.12 0.12 0.18 rg BT /${l.bold ? 'F2' : 'F1'} ${size} Tf 54 ${y} Td (${pdfText(l.text)}) Tj ET`);
    y -= l.gap ?? size + 7;
    if (y < 60) break;
  }
  ops.push(`0.55 0.56 0.62 rg BT /F1 9 Tf 54 36 Td (Stored in Hearth - Rivera Family) Tj ET`);
  const stream = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A card-like SVG "scan" (insurance card, ID page…). */
export function makeCardSvg({ title, subtitle, rows = [], from = '#5B5BD6', to = '#8E4EC6', badge = '' }) {
  const rowSvg = rows
    .map(([k, v], i) => {
      const x = i % 2 ? 330 : 48;
      const y = 250 + Math.floor(i / 2) * 64;
      return `<text x="${x}" y="${y}" font-size="15" fill="#ffffffb3" letter-spacing="1.5">${esc(k.toUpperCase())}</text>
<text x="${x}" y="${y + 26}" font-size="24" font-weight="700" fill="#fff">${esc(v)}</text>`;
    })
    .join('\n');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="404" viewBox="0 0 640 404" font-family="Inter, Helvetica, Arial, sans-serif">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
<rect width="640" height="404" rx="28" fill="url(#g)"/>
<circle cx="560" cy="60" r="140" fill="#ffffff14"/><circle cx="600" cy="360" r="90" fill="#ffffff10"/>
<text x="48" y="84" font-size="32" font-weight="800" fill="#fff">${esc(title)}</text>
<text x="48" y="118" font-size="18" fill="#ffffffcc">${esc(subtitle)}</text>
${badge ? `<rect x="48" y="146" rx="12" width="${badge.length * 11 + 28}" height="32" fill="#ffffff26"/><text x="62" y="168" font-size="15" font-weight="700" fill="#fff">${esc(badge)}</text>` : ''}
${rowSvg}
</svg>`);
}

// ---- seed data ------------------------------------------------------------------------------

const ago = (days, hours = 0) => new Date(Date.now() - days * 864e5 - hours * 36e5).toISOString();
function inDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const year = new Date().getFullYear();

export async function seedVault(ctx, { familyId, users }) {
  const { db } = ctx;
  const { alex, sam, mia, leo } = users;

  // ---- contacts ----
  const contacts = [
    { name: 'Emergency services', category: 'emergency', role: 'Police · Fire · Ambulance', phones: [{ label: 'Emergency', number: '911' }], emergency: 1, by: alex, at: 80,
      notes: 'Give our address first: 214 Willow Lane, Maplewood. Cross street is Birch Ave.' },
    { name: 'Poison Control', category: 'emergency', role: '24/7 helpline', phones: [{ label: 'Helpline', number: '+1 800 222 1222' }], website: 'https://www.poison.org', emergency: 1, by: alex, at: 80 },
    { name: 'Dr. Priya Patel', category: 'medical', role: 'Pediatrician', organization: 'Maple Grove Pediatrics', phones: [{ label: 'Office', number: '+1 555 0142' }, { label: 'After hours', number: '+1 555 0199' }],
      email: 'frontdesk@maplegrovepeds.example', address: '1200 Maple Grove Rd, Suite 3, Maplewood', website: 'https://maplegrovepeds.example', favorite: 1, emergency: 1, by: sam, at: 70,
      notes: "Mia & Leo's doctor since 2017. Same-day sick visits if you call before 9am." },
    { name: 'Bright Smiles Family Dentistry', category: 'medical', role: 'Dentist — Dr. Kevin Osei', phones: [{ label: 'Office', number: '+1 555 0177' }], email: 'hello@brightsmiles.example',
      address: '48 Harbor St, Maplewood', notes: 'Cleanings every 6 months. Next: Leo in November.', by: sam, at: 60 },
    { name: 'Lincoln Elementary', category: 'school', role: 'Front office', phones: [{ label: 'Office', number: '+1 555 0110' }, { label: 'Attendance line', number: '+1 555 0111' }],
      email: 'office@lincoln-elem.example', address: '900 School St, Maplewood', website: 'https://lincoln-elem.example', favorite: 1, by: alex, at: 65,
      notes: 'Report absences before 8:30am on the attendance line. Pickup gate closes at 3:20pm.' },
    { name: 'Hannah Brooks', category: 'school', role: "Mia's 6th-grade teacher", organization: 'Lincoln Elementary', email: 'h.brooks@lincoln-elem.example', by: sam, at: 30,
      notes: 'Prefers email. Parent–teacher conferences in November.' },
    { name: 'Coach Marcus Daniels', category: 'school', role: "Leo's soccer coach", organization: 'Maplewood Youth Soccer', phones: [{ label: 'Mobile', number: '+1 555 0163' }], by: alex, at: 25,
      notes: 'Practice Tue & Thu 5pm at Riverside Park, field 3.' },
    { name: 'Emma Castillo', category: 'childcare', role: 'Babysitter', phones: [{ label: 'Mobile', number: '+1 555 0156' }], email: 'emma.castillo@mail.example', favorite: 1, by: alex, at: 12,
      notes: 'Available weekdays after 3pm and most Saturdays. CPR certified. $18/hr. Kids love her!' },
    { name: 'Grandma Rosa', category: 'family', role: "Alex's mom", phones: [{ label: 'Mobile', number: '+1 555 0120' }, { label: 'Home', number: '+1 555 0121' }],
      address: '77 Orchard Way, Brookside', favorite: 1, emergency: 1, by: alex, at: 85, notes: 'Second emergency contact on school forms. Has a car seat for Leo.' },
    { name: 'Linda Chen', category: 'family', role: 'Neighbor (has our spare key)', phones: [{ label: 'Mobile', number: '+1 555 0134' }], address: '216 Willow Lane, Maplewood', emergency: 1, by: sam, at: 50 },
    { name: "Mike's Plumbing", category: 'home', role: 'Plumber — Mike Donovan', phones: [{ label: 'Office', number: '+1 555 0181' }, { label: '24/7 emergencies', number: '+1 555 0182' }],
      website: 'https://mikesplumbing.example', notes: 'Fixed the water heater in March. Ask for Mike directly.', by: alex, at: 40 },
    { name: 'Sparky Electric', category: 'home', role: 'Electrician', phones: [{ label: 'Office', number: '+1 555 0187' }], email: 'jobs@sparky.example', by: sam, at: 35 },
    { name: 'Riverside Veterinary Clinic', category: 'pets', role: 'Vet — Dr. Ana Alvarez', phones: [{ label: 'Clinic', number: '+1 555 0171' }], address: '5 Riverside Dr, Maplewood',
      notes: "Biscuit's rabies booster due in spring.", by: sam, at: 20 },
  ];
  const insContact = db.prepare(
    `INSERT INTO vault_contacts (family_id, name, category, role, organization, phones, email, address, website, notes, favorite, emergency, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const contactIds = {};
  const insFav = db.prepare('INSERT OR IGNORE INTO vault_contact_favorites (contact_id, user_id) VALUES (?, ?)');
  for (const c of contacts) {
    const at = ago(c.at);
    const id = Number(insContact.run(familyId, c.name, c.category, c.role ?? null, c.organization ?? null, JSON.stringify(c.phones ?? []), c.email ?? null,
      c.address ?? null, c.website ?? null, c.notes ?? null, 0, c.emergency ?? 0, c.by.id, at, at).lastInsertRowid);
    contactIds[c.name] = id;
    // Favorites are per person: the parents share most, the kids have their own.
    if (c.favorite) for (const u of [alex, sam]) insFav.run(id, u.id);
  }
  insFav.run(contactIds['Emma Castillo'], mia.id);
  insFav.run(contactIds['Grandma Rosa'], mia.id);
  insFav.run(contactIds['Coach Marcus Daniels'], leo.id);
  insFav.run(contactIds['Grandma Rosa'], leo.id);

  // ---- folders ----
  const folderDefs = [
    { key: 'medical', name: 'Medical', color: '#E5484D', icon: 'medical', by: sam, at: 70 },
    { key: 'school', name: 'School', color: '#0090FF', icon: 'school', by: sam, at: 64 },
    { key: 'insurance', name: 'Insurance', color: '#30A46C', icon: 'insurance', by: alex, at: 60 },
    { key: 'home', name: 'Home', color: '#F76B15', icon: 'home', by: alex, at: 58 },
    { key: 'travel', name: 'Travel & IDs', color: '#8E4EC6', icon: 'travel', by: alex, at: 55 },
  ];
  const folders = {};
  const insFolder = db.prepare('INSERT INTO vault_folders (family_id, name, color, icon, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const f of folderDefs) folders[f.key] = Number(insFolder.run(familyId, f.name, f.color, f.icon, f.by.id, ago(f.at), ago(f.at)).lastInsertRowid);

  // ---- documents ----
  const red = [0.8, 0.22, 0.25];
  const blue = [0, 0.45, 0.85];
  const green = [0.16, 0.55, 0.36];
  const orange = [0.87, 0.42, 0.1];
  const purple = [0.5, 0.3, 0.72];
  const vaccine = (who, dob, shots) => makePdf({
    title: `Immunization Record`, subtitle: `${who} · DOB ${dob} · Maple Grove Pediatrics`, color: red,
    lines: [{ text: 'Vaccine history', bold: true, size: 14 }, { rule: true }, ...shots.map((s) => s), '', { text: 'Provider: Dr. Priya Patel, MD', bold: true }, 'This record is valid for school and camp enrollment.'],
  });
  const docs = [
    { folder: 'medical', file: `Immunization record - Mia.pdf`, name: 'Immunization record – Mia', by: sam, at: 3,
      buf: vaccine('Mia Rivera', '2014-06-21', ['DTaP - 5 doses - completed 2019', 'MMR - 2 doses - completed 2018', 'Polio (IPV) - 4 doses - completed 2018', 'Varicella - 2 doses - completed 2018', 'Tdap - 1 dose - 2025', 'Influenza - annual - Oct ' + (year - 1)]) },
    { folder: 'medical', file: 'Immunization record - Leo.pdf', name: 'Immunization record – Leo', by: sam, at: 3,
      buf: vaccine('Leo Rivera', '2017-11-08', ['DTaP - 5 doses - completed 2022', 'MMR - 2 doses - completed 2021', 'Polio (IPV) - 4 doses - completed 2021', 'Hepatitis A - 2 doses - completed 2019', 'Influenza - annual - Oct ' + (year - 1)]) },
    { folder: 'medical', file: 'Health insurance card.svg', name: 'Health insurance card', by: alex, at: 45, adults: 1, notes: 'Front of the card — the back has the pharmacy BIN.',
      buf: makeCardSvg({ title: 'BlueShield PPO', subtitle: 'Family plan · Rivera', badge: 'MEMBER CARD', from: '#0b63c9', to: '#12A594', rows: [['Member', 'Alex Rivera'], ['Group', '88213'], ['Member ID', 'XJH 4471 2290'], ['Plan', 'PPO Gold 500']] }) },
    { folder: 'medical', file: 'Allergy action plan - Mia.pdf', name: 'Allergy action plan – Mia', by: sam, at: 28, notes: 'A copy is with the school nurse.',
      buf: makePdf({ title: 'Food Allergy Action Plan', subtitle: 'Mia Rivera · Grade 6 · Lincoln Elementary', color: orange, lines: [{ text: 'Allergies: peanuts, tree nuts', bold: true, size: 13 }, { rule: true }, 'Mild symptoms (itchy mouth, a few hives): give antihistamine, watch closely.', 'Severe symptoms (trouble breathing, swelling, repeated vomiting):', { text: '1. Inject epinephrine (EpiPen Jr) immediately.', bold: true }, '2. Call 911.', '3. Call parents: Alex +1 555 0101 · Sam +1 555 0102', '', 'EpiPen is kept in the front pocket of her backpack.'] }) },
    { folder: 'school', file: `School calendar ${year}-${String(year + 1).slice(2)}.pdf`, name: `School calendar ${year}–${String(year + 1).slice(2)}`, by: alex, at: 40,
      buf: makePdf({ title: 'Lincoln Elementary', subtitle: `School year calendar ${year}-${year + 1}`, color: blue, lines: [{ text: 'Key dates', bold: true, size: 14 }, { rule: true }, 'Sep 2 - First day of school', 'Oct 13 - Staff development day (no school)', 'Nov 11 - Veterans Day (no school)', 'Nov 24-28 - Thanksgiving break', 'Dec 21 - Jan 4 - Winter break', 'Feb 16 - Presidents Day', 'Mar 30 - Apr 3 - Spring break', 'Jun 11 - Last day of school (early release 12:30pm)'] }) },
    { folder: 'school', file: 'Field trip permission - Science Museum.pdf', name: 'Field trip permission – Science Museum', by: sam, at: 6,
      buf: makePdf({ title: 'Field Trip Permission', subtitle: 'Grade 6 · California Science Museum', color: blue, lines: ['Date: next Friday, 8:30am - 2:45pm', 'Cost: $15 (includes bus and planetarium show)', 'Bring: packed lunch, water bottle, comfortable shoes', '', { text: 'Signed: Sam Rivera (parent)', bold: true }] }) },
    { folder: 'school', file: 'School supply list.txt', name: 'School supply list', by: sam, at: 40,
      buf: Buffer.from(`Lincoln Elementary — supply lists\n\nMia (Grade 6)\n- 4 composition notebooks\n- Scientific calculator (TI-30XS)\n- Colored pencils (24)\n- 2 packs of loose-leaf paper\n- Earbuds for the Chromebook\n\nLeo (Grade 3)\n- 24 #2 pencils\n- Crayons (24) and glue sticks\n- Safety scissors\n- 2 boxes of tissues for the classroom\n- Pencil pouch\n`) },
    { folder: 'insurance', file: 'Home insurance policy.pdf', name: 'Home insurance policy', by: alex, at: 58, expires: inDays(210), adults: 1,
      buf: makePdf({ title: 'Homeowners Policy', subtitle: 'Harbor Mutual · Policy HM-2291-4410', color: green, lines: [{ text: 'Insured property: 214 Willow Lane, Maplewood', bold: true }, { rule: true }, 'Dwelling coverage: $480,000', 'Personal property: $240,000', 'Liability: $300,000', 'Deductible: $1,000', '', 'Claims line (24/7): +1 800 555 0150'] }) },
    { folder: 'insurance', file: 'Car insurance - Honda CR-V.pdf', name: 'Car insurance – Honda CR-V', by: alex, at: 50, expires: inDays(18), notes: 'Renewal quote arrives by email ~3 weeks before.',
      buf: makePdf({ title: 'Auto Insurance ID Card', subtitle: 'Harbor Mutual · 2021 Honda CR-V', color: green, lines: ['Policy: HA-7730-1128', 'Insured: Alex Rivera, Sam Rivera', 'VIN: 7FARW2H5XME0*****', `Effective until: ${inDays(18)}`, '', 'Roadside assistance: +1 800 555 0142'] }) },
    { folder: 'home', file: 'Appliance warranties.csv', name: 'Appliance warranties', by: alex, at: 30,
      buf: Buffer.from(`Appliance,Brand,Purchased,Warranty until,Receipt\nRefrigerator,Samsung,2023-05-14,2028-05-14,Email\nWasher,LG,2024-02-02,2027-02-02,Folder "Home"\nDryer,LG,2024-02-02,2027-02-02,Folder "Home"\nDishwasher,Bosch,2022-08-20,2025-08-20,Expired\nWater heater,Rheem,${year}-03-11,${year + 6}-03-11,Mike's Plumbing invoice\n`) },
    { folder: 'home', file: 'Babysitter instructions.txt', name: 'Babysitter instructions', by: sam, at: 12, notes: 'Printed copy is on the fridge.',
      buf: Buffer.from(`Hi Emma! Thanks for watching the kids.\n\nBedtimes: Leo 8:00pm, Mia 9:00pm (reading until 9:30 is OK)\nDinner: pasta in the fridge — 2 min in the microwave\nMia is allergic to peanuts & tree nuts — EpiPen is in her backpack\nNo screens after 7:30pm\n\nWi-Fi: see the "Guest Wi-Fi" card in Hearth\nNeighbor with a spare key: Linda Chen, +1 555 0134 (next door, 216)\nWe'll be back by 11pm. Call Alex +1 555 0101 or Sam +1 555 0102 anytime.\n`) },
    { folder: 'travel', file: 'Mia birth certificate.pdf', name: 'Birth certificate – Mia', by: alex, at: 55,
      buf: makePdf({ title: 'Certificate of Live Birth', subtitle: 'Certified copy', color: purple, lines: ['Name: Mia Rose Rivera', 'Date of birth: June 21, 2014', 'Place of birth: Maplewood General Hospital', 'Parents: Alex Rivera, Sam Rivera'] }) },
    { folder: 'travel', file: 'Passport - Alex.svg', name: 'Passport – Alex', by: alex, at: 54, private: 1, expires: inDays(26), notes: 'Renew before the summer trip!',
      buf: makeCardSvg({ title: 'PASSPORT', subtitle: 'United States of America', badge: 'PRIVATE COPY', from: '#1e2a5a', to: '#3d4f9c', rows: [['Surname', 'RIVERA'], ['Given names', 'ALEX'], ['Passport no.', '5•••••832'], ['Expires', inDays(26)]] }) },
    { folder: 'travel', file: 'Passport - Sam.svg', name: 'Passport – Sam', by: sam, at: 54, private: 1, expires: inDays(900),
      buf: makeCardSvg({ title: 'PASSPORT', subtitle: 'United States of America', badge: 'PRIVATE COPY', from: '#1e2a5a', to: '#8E4EC6', rows: [['Surname', 'RIVERA'], ['Given names', 'SAM'], ['Passport no.', '6•••••104'], ['Expires', inDays(900)]] }) },
    { folder: null, file: `Tax return ${year - 1}.pdf`, name: `Tax return ${year - 1}`, by: alex, at: 150, private: 1,
      buf: makePdf({ title: `Form 1040 - ${year - 1}`, subtitle: 'Alex & Sam Rivera · filed jointly', color: [0.3, 0.3, 0.36], lines: ['Filing status: Married filing jointly', 'Dependents: Mia Rivera, Leo Rivera', 'Prepared by: Oak Street Tax Services', '', 'Private copy - only visible to Alex in Hearth.'] }) },
    { folder: null, file: 'Summer camp brochure.pdf', name: 'Summer camp brochure', by: sam, at: 9,
      buf: makePdf({ title: 'Camp Pinecrest', subtitle: `Summer ${year + 1} · Ages 7-14`, color: [0.19, 0.64, 0.42], lines: ['Day camp: canoeing, archery, arts & crafts, nature hikes', 'Sessions: two weeks each, June - August', 'Early-bird registration closes March 1', '', 'Mia and Leo both want session 2!'] }) },
  ];
  const insDoc = db.prepare(
    `INSERT INTO vault_documents (family_id, folder_id, name, original_name, ext, mime, size, storage_key, owner_id, is_private, adults_only, notes, expires_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const MIME = { pdf: 'application/pdf', svg: 'image/svg+xml', txt: 'text/plain', csv: 'text/csv' };
  const docIds = {};
  for (const d of docs) {
    const ext = extOf(d.file);
    const key = writeVaultFile(ctx.uploadDir, familyId, ctx.box, d.buf, ext);
    const at = ago(d.at, 2);
    docIds[d.file] = Number(insDoc.run(familyId, d.folder ? folders[d.folder] : null, d.name, d.file, ext, MIME[ext] ?? 'application/octet-stream', d.buf.length, key,
      d.by.id, d.private ?? 0, d.adults ?? 0, ctx.box.seal(d.notes ?? null), d.expires ?? null, at, at).lastInsertRowid);
  }
  // Pretend the car-insurance reminder already went out, so a fresh seed doesn't immediately
  // notify; Alex's passport reminder is left for the sweep to deliver.
  db.prepare('UPDATE vault_documents SET expiry_notified_at = ? WHERE id = ?').run(ago(1), docIds['Car insurance - Honda CR-V.pdf']);

  // ---- info cards ----
  const notes = [
    { title: 'Home Wi-Fi', kind: 'wifi', by: alex, at: 20, fields: [['Network', 'RiveraHome-5G', false], ['Password', 'sunflower-maple-42', true]], body: 'Router is in the hall closet. Restart it if the internet drops.' },
    { title: 'Guest Wi-Fi', kind: 'wifi', by: alex, at: 20, fields: [['Network', 'RiveraGuest', false], ['Password', 'welcome-to-willow', true]], body: 'OK to share with babysitters and visitors.' },
    { title: 'Health insurance', kind: 'insurance', by: sam, at: 44, adults: 1, fields: [['Provider', 'BlueShield PPO Gold 500', false], ['Member ID', 'XJH 4471 2290', true], ['Group number', '88213', false], ['Member services', '+1 800 555 0190', false]] },
    { title: 'Alarm & door codes', kind: 'code', by: alex, at: 33, adults: 1, fields: [['Alarm code', '4815', true], ['Garage keypad', '2719', true], ['Lockbox (back gate)', '0621', true]], body: 'Alarm company: SafeHome, +1 555 0133. Password for the alarm operator is on the fridge magnet.' },
    { title: 'Mia — medical info', kind: 'medical', by: sam, at: 28, fields: [['Blood type', 'A+', false], ['Allergies', 'Peanuts, tree nuts (EpiPen Jr in backpack)', false], ['Daily medication', 'None', false], ['Insurance ID', 'XJH 4471 2290-03', true]] },
    { title: 'Honda CR-V', kind: 'vehicle', by: alex, at: 48, adults: 1, fields: [['Plate', '8XKT 219', false], ['VIN', '7FARW2H5XME012845', true], ['Roadside assistance', '+1 800 555 0142', false]], body: 'Oil change every 5,000 miles — next at 42,000.' },
    { title: 'Passport numbers', kind: 'id', by: alex, at: 54, private: 1, fields: [['Alex', '548211832', true], ['Sam', '611902104', true], ['Mia', '702245519', true], ['Leo', '702245520', true]] },
    { title: 'Joint savings account', kind: 'bank', by: sam, at: 70, private: 1, fields: [['Bank', 'Harbor Credit Union', false], ['Routing number', '321174851', true], ['Account number', '0044 9187 2230', true]] },
  ];
  const insNote = db.prepare('INSERT INTO vault_notes (family_id, title, kind, fields, body, is_private, adults_only, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const noteIds = {};
  for (const n of notes) {
    const at = ago(n.at);
    const fields = JSON.stringify(n.fields.map(([label, value, secret]) => ({ label, value, secret })));
    noteIds[n.title] = Number(insNote.run(familyId, n.title, n.kind, ctx.box.seal(fields), ctx.box.seal(n.body ?? null),
      n.private ?? 0, n.adults ?? 0, n.by.id, at, at).lastInsertRowid);
  }

  // ---- a little history on the Wall ----
  const log = (user, verb, entityId, summary, link, createdAt) =>
    ctx.logActivity({ familyId, userId: user.id, module: 'vault', verb, entityId, summary, link, createdAt });
  log(alex, 'created_folder', folders.insurance, 'created the folder Insurance in Documents', `/vault/docs/f/${folders.insurance}`, ago(60));
  log(alex, 'added_note', noteIds['Home Wi-Fi'], 'saved the info card Home Wi-Fi', `/vault/notes/${noteIds['Home Wi-Fi']}`, ago(20));
  log(alex, 'added_contact', contactIds['Emma Castillo'], 'added Emma Castillo to Contacts', `/vault/contacts/${contactIds['Emma Castillo']}`, ago(12));
  log(sam, 'uploaded', docIds['Summer camp brochure.pdf'], 'uploaded Summer camp brochure', `/vault/docs/d/${docIds['Summer camp brochure.pdf']}`, ago(9, 2));
  log(sam, 'uploaded', docIds['Immunization record - Mia.pdf'], 'uploaded 2 documents to Medical', `/vault/docs/f/${folders.medical}`, ago(3, 2));
  return { contacts: Object.keys(contactIds).length, folders: Object.keys(folders).length, documents: Object.keys(docIds).length, notes: Object.keys(noteIds).length };
}
