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
    component: ComponentCreator('/docs/', '2a4'),
    routes: [
      {
        path: '/docs/',
        component: ComponentCreator('/docs/', '04c'),
        routes: [
          {
            path: '/docs/',
            component: ComponentCreator('/docs/', '07a'),
            routes: [
              {
                path: '/docs/api/',
                component: ComponentCreator('/docs/api/', 'bb3'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/architectui-migration/',
                component: ComponentCreator('/docs/architectui-migration/', '747'),
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
                path: '/docs/dashboard/',
                component: ComponentCreator('/docs/dashboard/', '582'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/db-admin/',
                component: ComponentCreator('/docs/db-admin/', 'b83'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/deploy/',
                component: ComponentCreator('/docs/deploy/', 'eca'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/finance/',
                component: ComponentCreator('/docs/finance/', '752'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/glossary/',
                component: ComponentCreator('/docs/glossary/', '411'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/login/',
                component: ComponentCreator('/docs/login/', 'fc9'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/manager-sales/',
                component: ComponentCreator('/docs/manager-sales/', 'e4f'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/marketplaces/',
                component: ComponentCreator('/docs/marketplaces/', '351'),
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
                path: '/docs/medmarket/',
                component: ComponentCreator('/docs/medmarket/', '281'),
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
                path: '/docs/ms-orders/',
                component: ComponentCreator('/docs/ms-orders/', '04b'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/ms-sales/',
                component: ComponentCreator('/docs/ms-sales/', '2be'),
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
                path: '/docs/network-prices/',
                component: ComponentCreator('/docs/network-prices/', 'bf0'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/ops-sheet/',
                component: ComponentCreator('/docs/ops-sheet/', 'd92'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/panel-map/',
                component: ComponentCreator('/docs/panel-map/', '919'),
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
                path: '/docs/product-analysis/',
                component: ComponentCreator('/docs/product-analysis/', '9b6'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/product/',
                component: ComponentCreator('/docs/product/', '7e7'),
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
                path: '/docs/purchase/',
                component: ComponentCreator('/docs/purchase/', 'cf9'),
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
                path: '/docs/script-versioning/',
                component: ComponentCreator('/docs/script-versioning/', '2ea'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/sections/',
                component: ComponentCreator('/docs/sections/', '33b'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/settings/',
                component: ComponentCreator('/docs/settings/', '5bf'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/supplier-analysis/',
                component: ComponentCreator('/docs/supplier-analysis/', '1b0'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/suppliers/',
                component: ComponentCreator('/docs/suppliers/', '4c9'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/work-schedule/',
                component: ComponentCreator('/docs/work-schedule/', '91a'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/docs/',
                component: ComponentCreator('/docs/', '3cd'),
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
