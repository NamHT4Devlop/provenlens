package com.acme.domain;

import java.time.LocalDate;

public class Donation {
    private Long id;
    private String donorName;
    private int amount;
    private LocalDate receivedOn;

    public Donation(Long id, String donorName, int amount) {
        this.id = id;
        this.donorName = donorName;
        this.amount = amount;
    }

    public Long getId() {
        return id;
    }

    public String getDonorName() {
        return donorName;
    }

    public int getAmount() {
        return amount;
    }

    public boolean isLarge() {
        return amount > 1000;
    }
}
