package com.acme.lombok;

import lombok.Data;
import lombok.experimental.Accessors;

@Data
@Accessors(chain = true)
public class Ticket {
    private String seat;
}
