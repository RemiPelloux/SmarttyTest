import { Component } from "./core";
import { FormatService } from "./format.service";

@Component({
  selector: "app-price",
  template: "<b>{{ text }}</b>",
})
export class PriceComponent {
  text = new FormatService().money(12.5);
}
