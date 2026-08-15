export interface DonationLike {
  amount: number;
  donorName: string;
}

export class Donation implements DonationLike {
  constructor(
    public readonly amount: number,
    public readonly donorName: string,
  ) {}

  isLarge(): boolean {
    return this.amount > 1000;
  }

  describe(): string {
    return `${this.donorName}: ${this.amount}`;
  }
}
