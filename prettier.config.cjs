module.exports = {
  alignPropertyValues: 'group',
  alignEnumValues    : 'group',
  printWidth         : 100,
  singleQuote        : true,
  trailingComma      : 'all',
  semi               : true,
  overrides: [
    {
      files  : ['*.md', '*.MD', '*.markdown'],
      options: {
        proseWrap  : 'always',
        printWidth : 90,
        tabWidth   : 4,
        singleQuote: false,
      },
    },
  ],
};
