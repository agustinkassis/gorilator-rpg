const express = require('express');
const app = express();
const LightningEconomy = require('./plugins/lightning-economy/index');
const QuestRewards = require('./plugins/lightning-economy/quest-rewards');
const BountyBoard = require('./plugins/lightning-economy/bounty-board');

const operatorWallet = 'operator-wallet-npub'; // Replace with operator wallet npub
const lightningEconomy = new LightningEconomy(operatorWallet);
const questRewards = new QuestRewards(lightningEconomy);
const bountyBoard = new BountyBoard(lightningEconomy);

app.post('/reward-player', async (req, res) => {
  const playerLud16 = req.body.playerLud16;
  const amountSats = req.body.amountSats;
  const zapResult = await questRewards.rewardPlayerForQuest(playerLud16, 'quest-id', amountSats);
  res.json(zapResult);
});

app.post('/create-bounty', async (req, res) => {
  const boardId = req.body.boardId;
  const amountSats = req.body.amountSats;
  const bounty = await bountyBoard.createBounty(boardId, amountSats);
  res.json(bounty);
});

app.get('/get-bounties', async (req, res) => {
  const boardId = req.query.boardId;
  const bounties = await bountyBoard.getBounties(boardId);
  res.json(bounties);
});

app.listen(3000, () => {
  console.log('Server listening on port 3000');
});