import { Component } from "./core";

@Component({
  selector: "app-badge",
  templateUrl: "./badge.component.html",
  styleUrl: "./badge.component.css",
})
export class BadgeComponent {
  label = "new";
}
