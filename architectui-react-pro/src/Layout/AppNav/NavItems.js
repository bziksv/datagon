export const MainNav = [
  {
    icon: "pe-7s-rocket",
    label: "Дашборды",
    content: [
      {
        label: "Аналитика",
        to: "/dashboards/analytics",
      },
      {
        label: "Коммерция",
        to: "/dashboards/commerce",
      },
      {
        label: "Продажи",
        to: "/dashboards/sales",
      },
      {
        label: "Минималистичный",
        content: [
          {
            label: "Вариант 1",
            to: "/dashboards/minimal-dashboard-1",
          },
          {
            label: "Вариант 2",
            to: "/dashboards/minimal-dashboard-2",
          },
        ],
      },
      {
        label: "CRM",
        to: "/dashboards/crm",
      },
    ],
  },
  {
    icon: "pe-7s-browser",
    label: "Страницы",
    content: [
      {
        label: "Вход",
        to: "/pages/login",
      },
      {
        label: "Вход (boxed)",
        to: "/pages/login-boxed",
      },
      {
        label: "Регистрация",
        to: "/pages/register",
      },
      {
        label: "Регистрация (boxed)",
        to: "/pages/register-boxed",
      },
      {
        label: "Забыли пароль",
        to: "/pages/forgot-password",
      },
      {
        label: "Забыли пароль (boxed)",
        to: "/pages/forgot-password-boxed",
      },
    ],
  },
  {
    icon: "pe-7s-plugin",
    label: "Приложения",
    content: [
      {
        label: "Почта",
        to: "/apps/mailbox",
      },
      {
        label: "Чат",
        to: "/apps/chat",
      },
      {
        label: "FAQ",
        to: "/apps/faq-section",
      },
    ],
  },
];
export const ComponentsNav = [
  {
    icon: "pe-7s-diamond",
    label: "Элементы",
    content: [
      {
        label: "Кнопки",
        content: [
          {
            label: "Стандартные",
            to: "/elements/buttons-standard",
          },
          {
            label: "Кнопки-pill",
            to: "/elements/buttons-pills",
          },
          {
            label: "Квадратные",
            to: "/elements/buttons-square",
          },
          {
            label: "С тенью",
            to: "/elements/buttons-shadow",
          },
          {
            label: "С иконками",
            to: "/elements/buttons-icons",
          },
        ],
      },
      {
        label: "Выпадающие списки",
        to: "/elements/dropdowns",
      },
      {
        label: "Иконки",
        to: "/elements/icons",
      },
      {
        label: "Бейджи",
        to: "/elements/badges-labels",
      },
      {
        label: "Карточки",
        to: "/elements/cards",
      },
      {
        label: "Индикаторы загрузки",
        to: "/elements/loaders",
      },
      {
        label: "Списки",
        to: "/elements/list-group",
      },
      {
        label: "Навигационные меню",
        to: "/elements/navigation",
      },
      {
        label: "Таймлайн",
        to: "/elements/timelines",
      },
      {
        label: "Утилиты",
        to: "/elements/utilities",
      },
      {
        label: "Сенсор видимости",
        to: "/elements/visibility-sensor",
      },
    ],
  },
  {
    icon: "pe-7s-car",
    label: "Компоненты",
    content: [
      {
        label: "Табы",
        to: "/components/tabs",
      },
      {
        label: "Аккордеоны",
        to: "/components/accordion",
      },
      {
        label: "Уведомления",
        to: "/components/notifications",
      },
      {
        label: "Модальные окна",
        to: "/components/modals",
      },
      {
        label: "Блокеры загрузки",
        to: "/components/block-ui",
      },
      {
        label: "Прогресс-бар",
        to: "/components/progress-bar",
      },
      {
        label: "Подсказки и поповеры",
        to: "/components/tooltips-popovers",
      },
      {
        label: "Карусель",
        to: "/components/carousel",
      },
      {
        label: "Календарь",
        to: "/components/calendar",
      },
      {
        label: "Пагинация",
        to: "/components/pagination",
      },
      {
        label: "Счетчик",
        to: "/components/count-up",
      },
      {
        label: "Закрепленные элементы",
        to: "/components/sticky-elements",
      },
      {
        label: "Прокрутка",
        to: "/components/scrollable-elements",
      },
      {
        label: "Карты",
        to: "/components/maps",
      },
      {
        label: "Рейтинги",
        to: "/components/rating",
      },
      {
        label: "Обрезка изображений",
        to: "/components/image-crop",
      },
      {
        label: "Гид-туры",
        to: "/components/guided-tours",
      },
    ],
  },
  {
    icon: "pe-7s-display2",
    label: "Таблицы",
    content: [
      {
        label: "Таблицы данных",
        to: "/tables/data-tables",
      },
      {
        label: "Обычные таблицы",
        to: "/tables/regular-tables",
      },
      {
        label: "Сеточные таблицы",
        to: "/tables/grid-tables",
      },
    ],
  },
];
export const FormsNav = [
  {
    icon: "pe-7s-light",
    label: "Элементы",
    content: [
      {
        label: "Контролы",
        to: "/forms/controls",
      },
      {
        label: "Макеты",
        to: "/forms/layouts",
      },
      {
        label: "Валидация",
        to: "/forms/validation",
      },
      {
        label: "Мастер",
        to: "/forms/wizard",
      },
      {
        label: "Закрепленные заголовки форм",
        to: "/forms/sticky-headers",
      },
    ],
  },
  {
    icon: "pe-7s-joy",
    label: "Виджеты",
    content: [
      {
        label: "Выбор даты",
        to: "/forms/date-picker",
      },
      {
        label: "Диапазонный слайдер",
        to: "/forms/range-slider",
      },
      {
        label: "Мультивыбор",
        to: "/forms/input-selects",
      },
      {
        label: "Переключатель",
        to: "/forms/toggle-switch",
      },
      {
        label: "Выпадающие списки",
        to: "/forms/dropdown",
      },
      {
        label: "Визуальный редактор",
        to: "/forms/wysiwyg-editor",
      },
      {
        label: "Маска ввода",
        to: "/forms/input-mask",
      },
      {
        label: "Автодополнение",
        to: "/forms/typeahead",
      },
      {
        label: "Зона загрузки",
        to: "/forms/dropzone",
      },
      {
        label: "Выбор цвета",
        to: "/forms/color-picker",
      },
    ],
  },
];
export const WidgetsNav = [
  {
    icon: "pe-7s-graph1",
    label: "Графические блоки",
    content: [
      {
        label: "Вариант 1",
        to: "/widgets/chart-boxes-1",
      },
      {
        label: "Вариант 2",
        to: "/widgets/chart-boxes-2",
      },
      {
        label: "Вариант 3",
        to: "/widgets/chart-boxes-3",
      },
    ],
  },
  {
    icon: "pe-7s-display2",
    label: "Профильные блоки",
    to: "/widgets/profile-boxes",
  },
  {
    icon: "pe-7s-plugin",
    label: "Контентные блоки",
    to: "/widgets/content-boxes",
  },
];
export const ChartsNav = [
  {
    icon: "pe-7s-graph1",
    label: "Графики ChartJS",
    to: "/charts/chartjs",
  },
  {
    icon: "pe-7s-graph1",
    label: "Графики Apex",
    to: "/charts/apex-charts",
  },
  {
    icon: "pe-7s-graph1",
    label: "Мини-графики",
    content: [
      {
        label: "Вариант 1",
        to: "/charts/sparklines-1",
      },
      {
        label: "Вариант 2",
        to: "/charts/sparklines-2",
      },
    ],
  },
  {
    icon: "pe-7s-graph1",
    label: "Гейджи",
    to: "/charts/gauges",
  },
];

export const DatagonNav = [
  {
    icon: "pe-7s-global",
    label: "Мои сайты",
    to: "/my-sites",
  },
  {
    icon: "pe-7s-box2",
    label: "Мои товары",
    to: "/my-products",
  },
  {
    icon: "pe-7s-shopbag",
    label: "МойСклад",
    to: "/moysklad",
  },
  {
    icon: "pe-7s-portfolio",
    label: "Конкуренты",
    to: "/projects",
  },
  {
    icon: "pe-7s-network",
    label: "Очередь",
    to: "/queue",
  },
  {
    icon: "pe-7s-note2",
    label: "Результаты",
    to: "/results",
  },
  {
    icon: "pe-7s-link",
    label: "Сопоставление",
    to: "/matches",
  },
  {
    icon: "pe-7s-timer",
    label: "Логи",
    to: "/processes",
  },
  {
    icon: "pe-7s-config",
    label: "Настройки",
    to: "/settings",
  },
];

