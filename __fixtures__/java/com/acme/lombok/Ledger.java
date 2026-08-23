package com.acme.lombok;

import java.util.List;

public class Ledger {
    private List<Receipt> receipts;
    private final Store store;

    public Ledger(Store store) {
        this.store = store;
    }

    public void summarise(Stamp stamp) {
        receipts.forEach(receipt -> receipt.getNote());
        store.load(Receipt.class, stamp.code()).map(found -> found.getId());
        var built = Receipt.builder().note("x").build();
        built.setSettled(true);
        new Ticket().setSeat("1A").getSeat();
    }
}
