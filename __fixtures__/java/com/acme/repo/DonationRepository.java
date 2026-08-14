package com.acme.repo;

import com.acme.domain.Donation;
import java.util.List;

public interface DonationRepository {
    Donation findById(Long id);

    List<Donation> findAll();

    Donation save(Donation donation);
}
