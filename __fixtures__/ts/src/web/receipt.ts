import { Donation } from '@domain/donation';
import { DonationService } from '../service/donationService';
import { InMemoryDonationRepository } from '../repo/donationRepository';

export interface Receipt {
  donation: Donation;
  service: DonationService;
}

export function buildService(): DonationService {
  return new DonationService(new InMemoryDonationRepository());
}

// `Receipt['donation']` does not describe a type, it points at one this index
// already holds -- the `donation` member of Receipt.
export function describeReceipt(donation: Receipt['donation']): string {
  return donation.describe();
}

// `ReturnType<typeof buildService>` points at a declaration in the same way:
// whatever `buildService` says it returns.
export function summariseVia(service: ReturnType<typeof buildService>, donation: Donation): string {
  return service.summarise(donation);
}
