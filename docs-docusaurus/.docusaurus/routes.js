import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/docs/search/',
    component: ComponentCreator('/docs/search/', '6c9'),
    exact: true
  },
  {
    path: '/docs/',
    component: ComponentCreator('/docs/', '1fe'),
    routes: [
      {
        path: '/docs/',
        component: ComponentCreator('/docs/', 'bbb'),
        routes: [
          {
            path: '/docs/',
            component: ComponentCreator('/docs/', 'e46'),
            routes: [
              {
                path: '/docs/api/',
                component: ComponentCreator('/docs/api/', 'bb3'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/capture-screenshots/',
                component: ComponentCreator('/docs/capture-screenshots/', '0ba'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/manual/',
                component: ComponentCreator('/docs/manual/', 'de0'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/matches/',
                component: ComponentCreator('/docs/matches/', 'e00'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/moysklad/',
                component: ComponentCreator('/docs/moysklad/', 'c7e'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/myproducts/',
                component: ComponentCreator('/docs/myproducts/', '1a8'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/mysites/',
                component: ComponentCreator('/docs/mysites/', '6c9'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/processes/',
                component: ComponentCreator('/docs/processes/', '59f'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/projects/',
                component: ComponentCreator('/docs/projects/', 'e0a'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/queue/',
                component: ComponentCreator('/docs/queue/', '8f9'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/results/',
                component: ComponentCreator('/docs/results/', '747'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/settings/',
                component: ComponentCreator('/docs/settings/', '5bf'),
                exact: true,
                sidebar: "docsSidebar"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
