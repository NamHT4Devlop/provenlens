package com.acme.service;

import com.acme.domain.Donation;
import com.acme.repo.DonationRepository;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class DonationServiceImpl extends BaseService implements DonationService {

    private final DonationRepository repository;

    @Autowired
    public DonationServiceImpl(DonationRepository repository) {
        this.repository = repository;
    }

    @Override
    public Donation record(String donorName, int amount) {
        audit("record donation");
        Donation donation = new Donation(null, donorName, amount);
        return repository.save(donation);
    }

    @Override
    public List<Donation> listAll() {
        return repository.findAll();
    }

    @Override
    public int totalRaised() {
        int total = 0;
        for (Donation d : repository.findAll()) {
            total += d.getAmount();
        }
        return total;
    }
}
