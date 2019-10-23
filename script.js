const fs = require('fs');

const data = fs.readFileSync('./blogs-original.csv');

const rows = data.toString().split('\n');

const table = rows
  .map(row => row.split(','))
  .filter((row, i) => row.length === 3 && i !== 0);

console.log(table);
