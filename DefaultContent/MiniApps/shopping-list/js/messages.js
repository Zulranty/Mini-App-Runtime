(() => {
  'use strict';

  const english = Object.freeze({
    "goods (few)": "goods",
    "opening quote": "\"",
    "closing quote": "\"",
    "category removed suffix": "\" removed",
    "category deletion count prefix": ""
  });
  const messages = globalThis.ShoppingListMessages ?? {};
  globalThis.translateShoppingList = key => {
    if (Object.hasOwn(messages, key)) return messages[key];
    return Object.hasOwn(english, key) ? english[key] : key;
  };
})();
