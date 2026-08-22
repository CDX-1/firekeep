"""firekeep - run me with: python3 main.py"""


class Bonfire:
    def __init__(self, name, fuel=10):
        self.name = name
        self.fuel = fuel

    def stoke(self, amount=5):
        self.fuel += amount
        return self.fuel

    def burn(self, ticks=1):
        self.fuel = max(0, self.fuel - ticks)
        return self.fuel

    def is_lit(self):
        return self.fuel > 0

    def __str__(self):
        state = "lit" if self.is_lit() else "out"
        return f"{self.name}: {state} (fuel={self.fuel})"


def main():
    fire = Bonfire("firelink", fuel=5)
    print(fire)

    fire.stoke(3)
    print("after stoking:", fire)

    for i in range(1, 4):
        fire.burn(3)
        print(f"tick {i}:", fire)


if __name__ == "__main__":
    main()
