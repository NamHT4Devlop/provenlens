package com.acme.web;

import com.acme.domain.Donation;
import com.acme.service.DonationService;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/donations")
public class DonationController {

    @Autowired
    private DonationService donationService;

    @GetMapping
    public List<Donation> list() {
        return donationService.listAll();
    }

    @PostMapping
    public Donation create(String donorName, int amount) {
        Donation saved = donationService.record(donorName, amount);
        return saved;
    }

    @GetMapping("/total")
    public int total() {
        return donationService.totalRaised();
    }
}
