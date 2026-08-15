package com.acme.report;

import com.acme.domain.Donation;

/** Exercises overload resolution: three methods share the name `describe`. */
public class DonationFormatter {

    public String describe(Donation donation) {
        return donation.getDonorName();
    }

    public String describe(String donorName) {
        return donorName;
    }

    public String describe(Donation donation, boolean verbose) {
        return verbose ? describe(donation) : "";
    }

    public String report(Donation donation, String fallback) {
        String byDonation = describe(donation);
        String byName = describe(fallback);
        return byDonation + byName;
    }
}
