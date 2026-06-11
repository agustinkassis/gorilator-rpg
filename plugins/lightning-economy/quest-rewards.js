const LightningEconomy = require('./index');

class QuestRewards {
  constructor(lightningEconomy) {
    this.lightningEconomy = lightningEconomy;
  }

  async rewardPlayerForQuest(playerLud16, questId, amountSats) {
    // Reward player with sats for completing a quest
    const zapResult = await this.lightningEconomy.rewardPlayer(playerLud16, amountSats);
    return zapResult;
  }
}

module.exports = QuestRewards;