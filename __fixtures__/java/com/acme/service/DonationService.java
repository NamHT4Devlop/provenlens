package com.acme.service;

import com.acme.domain.Donation;
import java.util.List;

public interface DonationService {
    Donation record(String donorName, int amount);

    List<Donation> listAll();

    int totalRaised();
}
