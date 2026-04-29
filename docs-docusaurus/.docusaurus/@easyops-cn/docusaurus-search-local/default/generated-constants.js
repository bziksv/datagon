import lunr from "/Users/stanislav/Documents/projects/p.datagon.ru/docs-docusaurus/node_modules/lunr/lunr.js";
require("/Users/stanislav/Documents/projects/p.datagon.ru/docs-docusaurus/node_modules/lunr-languages/lunr.stemmer.support.js")(lunr);
require("/Users/stanislav/Documents/projects/p.datagon.ru/docs-docusaurus/node_modules/lunr-languages/lunr.ru.js")(lunr);
require("/Users/stanislav/Documents/projects/p.datagon.ru/docs-docusaurus/node_modules/lunr-languages/lunr.multi.js")(lunr);
export const removeDefaultStopWordFilter = [];
export const language = ["ru","en"];
export const searchIndexUrl = "search-index{dir}.json";
export const searchResultLimits = 8;
export const fuzzyMatchingDistance = 1;