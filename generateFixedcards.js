const fs = require('fs');

function generateBingoCard() {
  const card = [];
  const columns = { B: [1, 15], I: [16, 30], N: [31, 45], G: [46, 60], O: [61, 75] };

  for (const [_, [min, max]] of Object.entries(columns)) {
    const nums = new Set();
    while (nums.size < 5) {
      nums.add(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    card.push(...Array.from(nums));
  }
  card[12] = 0; // center free cell
  return card;
}

function areCardsEqual(card1, card2) {
  return card1.every((num, idx) => num === card2[idx]);
}

function generateUniqueCards(count = 100) {
  const cards = [];
  while (cards.length < count) {
    const newCard = generateBingoCard();
    if (!cards.some(c => areCardsEqual(c, newCard))) {
      cards.push(newCard);
    }
  }
  return cards;
}

const fixedCards = generateUniqueCards(100);
fs.writeFileSync('fixed_bingo_cards.json', JSON.stringify(fixedCards, null, 2));
console.log('Fixed set of 100 bingo cards generated and saved.');
