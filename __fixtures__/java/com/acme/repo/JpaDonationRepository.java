package com.acme.repo;

import com.acme.domain.Donation;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Repository;

@Repository
public class JpaDonationRepository implements DonationRepository {

    private final List<Donation> store = new ArrayList<>();

    @Override
    public Donation findById(Long id) {
        for (Donation d : store) {
            if (d.getId().equals(id)) {
                return d;
            }
        }
        return null;
    }

    @Override
    public List<Donation> findAll() {
        return store;
    }

    @Override
    public Donation save(Donation donation) {
        store.add(donation);
        return donation;
    }
}
