// Demo content for the Rivera family: groceries, weekend chores for the kids, a packing list and
// a few more lists so the module looks lived-in right after `npm run seed`.

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

export function seedLists(ctx, { familyId, users }, { day, guessCategory }) {
  const { db } = ctx;
  const { alex, sam, mia, leo } = users;

  const insertList = db.prepare(
    `INSERT INTO lists (family_id, name, type, icon, color, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO list_items (list_id, family_id, text, quantity, notes, category, assignee_id, due_date, done, done_by, done_at,
                             position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let listPos = 0;
  /**
   * items: [text, { qty, notes, who (assignee), due (day offset), done: [user, hoursAgo], by (creator), cat }]
   */
  function list({ name, type, icon, color, by, createdHoursAgo }, items) {
    const created = hoursAgo(createdHoursAgo);
    const { lastInsertRowid } = insertList.run(familyId, name, type, icon, color, listPos++, by.id, created, created);
    const id = Number(lastInsertRowid);
    items.forEach(([text, o = {}], i) => {
      const itemCreated = hoursAgo(Math.max(0.2, createdHoursAgo - i * 0.05));
      const category = type === 'shopping' ? o.cat ?? guessCategory(text) : null;
      insertItem.run(
        id, familyId, text, o.qty ?? null, o.notes ?? null, category, o.who?.id ?? null,
        o.due === undefined ? null : day(o.due),
        o.done ? 1 : 0, o.done ? o.done[0].id : null, o.done ? hoursAgo(o.done[1]) : null,
        i, (o.by ?? by).id, itemCreated, o.done ? hoursAgo(o.done[1]) : itemCreated,
      );
    });
    return id;
  }

  ctx.tx(db, () => {
    const groceries = list({ name: 'Groceries', type: 'shopping', icon: '🛒', color: '#30A46C', by: sam, createdHoursAgo: 24 * 20 }, [
      ['Bananas', { qty: '6', done: [sam, 20] }],
      ['Avocados', { qty: '3' }],
      ['Baby spinach' ],
      ['Cherry tomatoes', { qty: '2 packs' }],
      ['Lemons', { qty: '4' }],
      ['Sourdough bread', { done: [sam, 20] }],
      ['Tortillas', { notes: 'Whole wheat, for taco Tuesday' }],
      ['Oat milk', { qty: '2' }],
      ['Greek yogurt', { qty: '1 large tub' }],
      ['Eggs', { qty: '1 dozen', done: [alex, 44] }],
      ['Cheddar cheese' ],
      ['Chicken thighs', { qty: '2 lb' }],
      ['Ground beef', { qty: '1 lb' }],
      ['Penne pasta' ],
      ['Olive oil', { done: [sam, 20] }],
      ['Peanut butter', { notes: 'Crunchy!', by: leo }],
      ['Frozen peas' ],
      ['Ice cream', { notes: 'Cookie dough please 🙏', by: mia }],
      ['Sparkling water', { qty: '12 cans' }],
      ['Paper towels' ],
      ['Dish soap', { done: [alex, 44] }],
      ['Toothpaste', { by: mia }],
    ]);

    const chores = list({ name: 'Weekend chores', type: 'todo', icon: '🧹', color: '#F76B15', by: alex, createdHoursAgo: 24 * 6 }, [
      ['Clean your room', { who: mia, due: 0, notes: 'Clothes in the hamper, books on the shelf' }],
      ['Feed Pepper', { who: mia, due: 0, done: [mia, 2], notes: 'One scoop, fresh water too' }],
      ['Unload the dishwasher', { who: mia, due: -1 }],
      ['Water the plants', { who: leo, due: 1 }],
      ['Take out the recycling', { who: leo, due: -1 }],
      ['Tidy the playroom', { who: leo, due: 2 }],
      ['Make your bed', { who: leo, due: 0, done: [leo, 5] }],
      ['Mow the lawn', { who: sam, due: 2 }],
      ['Fix the leaky bathroom faucet', { who: alex, due: 0, notes: 'Washer size 1/2" — spare is in the garage drawer' }],
      ['Replace smoke detector batteries', { who: alex, due: -2 }],
      ['Vacuum the living room', { who: sam, due: -3, done: [sam, 30] }],
    ]);

    const packing = list({ name: 'Packing list — Lake trip', type: 'other', icon: '🧳', color: '#0090FF', by: sam, createdHoursAgo: 24 * 3 }, [
      ['Swimsuits', { who: sam, done: [sam, 26] }],
      ['Sunscreen SPF 50', { who: sam }],
      ['Beach towels', { qty: '4', who: mia, done: [mia, 22] }],
      ['Life jackets', { qty: '2', who: alex, notes: 'Kids’ sizes — check the straps' }],
      ['Phone chargers + power bank', { who: alex }],
      ['Hiking boots', { who: leo }],
      ['First aid kit', { who: sam, done: [sam, 26] }],
      ['Snacks for the car', { who: mia }],
      ['Mr. Buttons 🧸', { who: leo, notes: 'Do NOT forget. Seriously.', by: leo }],
      ['Board games', { who: leo }],
      ['Bug spray' ],
      ['Flashlights', { qty: '2' }],
    ]);

    const projects = list({ name: 'Home projects', type: 'todo', icon: '🛠️', color: '#8E4EC6', by: alex, createdHoursAgo: 24 * 30 }, [
      ['Paint the guest room', { who: sam, due: 6, notes: 'Color: “Morning Fog” — 2 gallons' }],
      ['Book gutter cleaning', { who: alex, due: 3 }],
      ['Research a new couch', { who: sam, notes: 'Something the dog can’t destroy' }],
      ['Donate old clothes', { who: alex, done: [alex, 72] }],
      ['Hang family photos in the hallway', { who: alex, due: 9 }],
    ]);

    list({ name: 'School stuff', type: 'todo', icon: '🎒', color: '#12A594', by: mia, createdHoursAgo: 24 * 4 }, [
      ['Science fair poster board', { who: mia, due: 4, by: mia }],
      ['Sign the field trip permission slip', { who: alex, due: 1, by: mia }],
      ['Return library books', { who: leo, due: 2, by: alex }],
      ['Buy new colored pencils', { who: sam, due: 5, by: mia }],
    ]);

    list({ name: 'Costco run', type: 'shopping', icon: '🛍️', color: '#12A594', by: alex, createdHoursAgo: 24 * 8 }, [
      ['Toilet paper', { qty: '1 big pack' }],
      ['Coffee beans', { qty: '2 bags', notes: 'Medium roast' }],
      ['Laundry detergent' ],
      ['Almonds' ],
      ['Frozen berries', { cat: 'Frozen' }],
      ['AA batteries', { done: [alex, 100] }],
    ]);

    list({ name: 'Gift ideas', type: 'other', icon: '🎁', color: '#D6409F', by: sam, createdHoursAgo: 24 * 40 }, [
      ['Grandma — photo book from the summer', { notes: 'Birthday Nov 12' }],
      ['Leo — LEGO space shuttle', { notes: 'The 1,000-piece one he saw at the store' }],
      ['Mia — watercolor set + sketchbook' ],
      ['Alex — new hiking backpack', { by: sam }],
    ]);

    // Wall entries (backdated) so the feed tells the story.
    const log = (user, verb, entityId, summary, h) =>
      ctx.logActivity({ familyId, userId: user.id, module: 'lists', verb, entityId, summary, link: `/lists/${entityId}`, createdAt: hoursAgo(h) });
    log(alex, 'created', projects, 'created the list 🛠️ Home projects', 24 * 30);
    log(sam, 'created', groceries, 'created the shopping list 🛒 Groceries', 24 * 20);
    log(alex, 'created', chores, 'created the list 🧹 Weekend chores', 24 * 6);
    log(alex, 'added', chores, 'added 11 items to Weekend chores', 24 * 6 - 0.2);
    log(sam, 'created', packing, 'created the list 🧳 Packing list — Lake trip', 24 * 3);
    log(sam, 'completed', packing, 'checked off 2 items on Packing list — Lake trip', 26);
    log(sam, 'completed', groceries, 'checked off 3 items on Groceries', 20);
    log(leo, 'completed', chores, 'completed “Make your bed” in Weekend chores', 5);
    log(mia, 'added', groceries, 'added “Ice cream” to Groceries', 3);
    log(mia, 'completed', chores, 'completed “Feed Pepper” in Weekend chores', 2);
  });
}
