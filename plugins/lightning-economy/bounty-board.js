const LightningEconomy = require('./index');

class BountyBoard {
  constructor(lightningEconomy) {
    this.lightningEconomy = lightningEconomy;
  }

  async createBounty(boardId, amountSats) {
    // Create a new bounty on the bounty board
    const bounty = await this.lightningEconomy.createBounty(boardId, amountSats);
    return bounty;
  }

  async getBounties(boardId) {
    // Retrieve bounties for a specific board
    const bounties = await this.lightningEconomy.getBounties(boardId);
    return bounties;
  }
}

module.exports = BountyBoard;