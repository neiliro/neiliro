/**
 * The demo family's copy, per language.
 *
 * The demo is a marketing surface: a visitor who reads Russian must find a
 * Russian household, not an English one wearing a translated interface. The
 * seeder is a function of this table, and `buildTemplate` produces one
 * template database per language (see sandbox.ts).
 *
 * `en` is the source and defines the shape; every other language is typed
 * as `DemoStrings`, so a forgotten string is a compile error rather than a
 * word of English sitting in the middle of a Russian demo. That guarantee
 * is the whole reason the seeder takes a table instead of translating
 * seeded rows afterwards.
 *
 * Not translated on purpose: person names that read the same in both
 * (Alex, Sam), real brands (Lidl), `.example` addresses, and enum-ish
 * column values like `father` or `preference`, which are keys the UI
 * translates on its own.
 */

const en = {
  users: {
    alex: 'Alex',
    sam: 'Sam',
  },

  projects: {
    home: { title: 'Home improvement', description: 'Everything the house keeps asking for' },
    trip: { title: 'Summer trip', description: 'Two weeks along the coast' },
  },

  tasks: {
    repaint: 'Repaint the hallway',
    pickColour: 'Pick the colour together',
    buyPaint: { title: 'Buy paint and tape', description: 'Two cans of Misty Sage and the wide tape' },
    tap: { title: 'Fix the dripping tap', description: 'The kitchen one — the washer kit is in the garage' },
    ferry: { title: 'Book the ferry', description: 'The evening crossing, the cabin with a window' },
    passports: 'Renew passports',
    coffeeMachine: 'Coffee machine in repair',
    confirmSchool: {
      title: 'Confirm parent-teacher evening',
      description: 'Reply to the school before Thursday',
    },
  },

  notes: {
    folder: 'Recipes',
    shopping: {
      title: 'Shopping list',
      /*
        The body carries a wiki-link to a task, and the link only resolves
        if it spells that task's title in this same language — hence the
        argument rather than a literal. Keep the brackets in every
        translation, and keep what is inside them identical to tasks.repaint.
      */
      body: (repaintTask: string): string =>
        `- Milk\n- Eggs\n- Coffee beans\n- Paint tape (see [[${repaintTask}]])\n- Something nice for Friday`,
    },
    dough: {
      title: 'Pizza dough',
      body: '**500 g** flour · 325 ml water · 10 g salt · 3 g yeast\n\nKnead, rest overnight in the fridge, bake as hot as the oven goes.',
    },
    guests: {
      title: 'House rules for guests',
      body: 'Wi-Fi: *neiliro / pizzafriday*\n\nCoffee machine: one scoop, button, patience.',
    },
  },

  events: {
    movie: {
      title: 'Movie night',
      description: 'The new Miyazaki — tickets are in the mail',
      location: 'Odeon',
    },
    gym: { title: 'Gym', description: 'Legs and the sauna after', location: 'Iron Temple' },
    dentist: {
      title: 'Dentist',
      description: 'The crown on the left, ask about a night guard',
      location: 'Dr. Molar',
    },
    grandmaBirthday: "Grandma's birthday",
    swim: { title: 'Swimming lesson', location: 'City pool' },
    market: {
      title: 'Farmers market',
      description: 'Bread, the good tomatoes, flowers if they have tulips',
    },
    carService: {
      title: 'Car service',
      description: 'The rattle from the back, and an oil change',
      location: 'Vulco',
    },
    dinner: "Dinner at Sam's parents",
    boiler: {
      title: 'Boiler service',
      description: 'The engineer from the email — someone has to be home',
    },
    vet: { title: "Vet — Bruno's shots", location: 'Dr. Pawel' },
    lake: { title: 'Lake weekend', description: 'Two nights, take the small tent' },
  },

  mail: {
    school: {
      fromName: 'Riverside School',
      subject: 'Parent-teacher evening on Thursday',
      body:
        'Dear parents,\n\n' +
        'We look forward to seeing you this Thursday at 17:30 in the main hall. ' +
        'Please confirm your attendance by replying to this email.\n\n' +
        'Riverside School office',
    },
    power: {
      fromName: 'City Power & Light',
      subject: 'Your electricity bill for July',
      body:
        'Your bill for July is ready: 64.20 EUR, due by the 25th.\n' +
        'The detailed statement is attached as a PDF in the original message.',
    },
  },

  profile: {
    shoes: 'Shoes',
    coffee: { label: 'Coffee', value: 'flat white, no sugar' },
    tea: { label: 'Tea', value: 'Earl Grey' },
    flowers: { label: 'Flowers', value: 'tulips, never lilies' },
    peanuts: 'peanuts',
  },

  wishes: {
    tamper: 'A proper espresso tamper',
    socks: 'Wool hiking socks',
    spa: 'Weekend at a spa',
    knife: 'A very sharp kitchen knife',
    claimedBy: 'Grandma Vera',
  },

  money: {
    accounts: { card: 'Joint card', cash: 'Cash' },
    categories: {
      groceries: 'Groceries',
      eatingOut: 'Eating out',
      household: 'Household',
      salary: 'Salary',
    },
    notes: {
      salary: 'Salary',
      pizza: 'Pizza night',
      rollers: 'Paint rollers',
      pocketCash: 'Pocket cash',
    },
    places: { lidl: 'Lidl', market: 'Market', pizzeria: 'Napoli', diy: 'DIY store' },
    recurring: {
      rent: 'Rent',
      salary: 'Salary',
      water: 'Water bill',
      internet: 'Internet',
    },
  },

  dashboard: {
    goalTitle: 'Trip to Japan',
    goalSavedLabel: 'Saved for the trip',
  },
};

export type DemoStrings = typeof en;

const ru: DemoStrings = {
  users: {
    alex: 'Alex',
    sam: 'Sam',
  },

  projects: {
    home: { title: 'Ремонт дома', description: 'Всё, о чём дом не устаёт напоминать' },
    trip: { title: 'Летняя поездка', description: 'Две недели вдоль побережья' },
  },

  tasks: {
    repaint: 'Перекрасить прихожую',
    pickColour: 'Вместе выбрать цвет',
    buyPaint: { title: 'Купить краску и скотч', description: 'Две банки «Туманный шалфей» и широкий малярный скотч' },
    tap: { title: 'Починить текущий кран', description: 'На кухне — ремкомплект прокладок в гараже' },
    ferry: { title: 'Забронировать паром', description: 'Вечерний рейс, каюта с окном' },
    passports: 'Обновить загранпаспорта',
    coffeeMachine: 'Кофемашина в ремонте',
    confirmSchool: {
      title: 'Подтвердить родительское собрание',
      description: 'Ответить школе до четверга',
    },
  },

  notes: {
    folder: 'Рецепты',
    shopping: {
      title: 'Список покупок',
      body: (repaintTask: string): string =>
        `- Молоко\n- Яйца\n- Кофе в зёрнах\n- Малярный скотч (см. [[${repaintTask}]])\n- Что-нибудь вкусное на пятницу`,
    },
    dough: {
      title: 'Тесто для пиццы',
      body: '**500 г** муки · 325 мл воды · 10 г соли · 3 г дрожжей\n\nВымесить, оставить на ночь в холодильнике, печь на максимуме, который выдаёт духовка.',
    },
    guests: {
      title: 'Правила дома для гостей',
      body: 'Wi-Fi: *neiliro / pizzafriday*\n\nКофемашина: одна ложка, кнопка, терпение.',
    },
  },

  events: {
    movie: {
      title: 'Вечер кино',
      description: 'Новый Миядзаки — билеты пришли на почту',
      location: 'Одеон',
    },
    gym: { title: 'Зал', description: 'Ноги и сауна после', location: 'Iron Temple' },
    dentist: {
      title: 'Стоматолог',
      description: 'Коронка слева, спросить про ночную капу',
      location: 'Доктор Моляр',
    },
    grandmaBirthday: 'День рождения бабушки',
    swim: { title: 'Бассейн', location: 'Городской бассейн' },
    market: {
      title: 'Фермерский рынок',
      description: 'Хлеб, те самые помидоры, цветы — если будут тюльпаны',
    },
    carService: {
      title: 'Машина на сервис',
      description: 'Стук сзади и замена масла',
      location: 'Vulco',
    },
    dinner: 'Ужин у родителей Сэма',
    boiler: {
      title: 'Обслуживание котла',
      description: 'Мастер из того письма — кто-то должен быть дома',
    },
    vet: { title: 'Ветеринар — прививки Бруно', location: 'Доктор Павел' },
    lake: { title: 'Выходные на озере', description: 'Две ночи, взять маленькую палатку' },
  },

  mail: {
    school: {
      fromName: 'Школа на Речной',
      subject: 'Родительское собрание в четверг',
      body:
        'Уважаемые родители,\n\n' +
        'Ждём вас в четверг в 17:30 в актовом зале. ' +
        'Пожалуйста, подтвердите участие ответом на это письмо.\n\n' +
        'Канцелярия школы на Речной',
    },
    power: {
      fromName: 'Горсвет',
      subject: 'Счёт за электричество за июль',
      body:
        'Ваш счёт за июль готов: 64,20 EUR, оплатить до 25-го.\n' +
        'Подробная выписка приложена PDF-файлом к исходному письму.',
    },
  },

  profile: {
    shoes: 'Обувь',
    coffee: { label: 'Кофе', value: 'флэт уайт, без сахара' },
    tea: { label: 'Чай', value: 'Эрл Грей' },
    flowers: { label: 'Цветы', value: 'тюльпаны, только не лилии' },
    peanuts: 'арахис',
  },

  wishes: {
    tamper: 'Нормальный темпер для эспрессо',
    socks: 'Шерстяные носки для походов',
    spa: 'Выходные в спа',
    knife: 'Очень острый кухонный нож',
    claimedBy: 'Бабушка Вера',
  },

  money: {
    accounts: { card: 'Общая карта', cash: 'Наличные' },
    categories: {
      groceries: 'Продукты',
      eatingOut: 'Кафе и рестораны',
      household: 'Дом',
      salary: 'Зарплата',
    },
    notes: {
      salary: 'Зарплата',
      pizza: 'Вечер пиццы',
      rollers: 'Малярные валики',
      pocketCash: 'На карманные',
    },
    places: { lidl: 'Lidl', market: 'Рынок', pizzeria: 'Napoli', diy: 'Строительный' },
    recurring: {
      rent: 'Аренда',
      salary: 'Зарплата',
      water: 'Счёт за воду',
      internet: 'Интернет',
    },
  },

  dashboard: {
    goalTitle: 'Поездка в Японию',
    goalSavedLabel: 'Накоплено на поездку',
  },
};

const TABLES = { en, ru };

export type DemoLang = keyof typeof TABLES;

export const DEMO_LANGS = Object.keys(TABLES) as DemoLang[];

export function isDemoLang(value: unknown): value is DemoLang {
  return typeof value === 'string' && (DEMO_LANGS as string[]).includes(value);
}

export function demoStrings(lang: DemoLang): DemoStrings {
  return TABLES[lang];
}
