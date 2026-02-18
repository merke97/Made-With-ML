"""A fun interactive app that teaches you whale facts!"""

import random

WHALE_FACTS = [
    {
        "species": "Blue Whale",
        "fact": "Blue whales are the largest animals ever known to have lived on Earth, reaching lengths of up to 100 feet and weighing as much as 200 tons.",
    },
    {
        "species": "Blue Whale",
        "fact": "A blue whale's heart is about the size of a small car, and its heartbeat can be detected from two miles away.",
    },
    {
        "species": "Humpback Whale",
        "fact": "Humpback whales sing complex songs that can last up to 20 minutes and be heard over 20 miles away.",
    },
    {
        "species": "Humpback Whale",
        "fact": "Humpback whales use a technique called bubble-net feeding, where they blow bubbles in a circle to trap fish.",
    },
    {
        "species": "Sperm Whale",
        "fact": "Sperm whales have the largest brain of any animal on Earth, weighing about 17 pounds.",
    },
    {
        "species": "Sperm Whale",
        "fact": "Sperm whales can dive to depths of over 7,000 feet and hold their breath for up to 90 minutes.",
    },
    {
        "species": "Beluga Whale",
        "fact": "Beluga whales are known as 'canaries of the sea' because they produce a wide variety of clicks, whistles, and chirps.",
    },
    {
        "species": "Beluga Whale",
        "fact": "Unlike most whales, belugas can move their necks and make facial expressions, giving them a remarkably expressive face.",
    },
    {
        "species": "Narwhal",
        "fact": "The narwhal's tusk is actually a long spiral tooth that can grow up to 10 feet. It contains millions of nerve endings and acts as a sensory organ.",
    },
    {
        "species": "Bowhead Whale",
        "fact": "Bowhead whales can live over 200 years, making them one of the longest-lived mammals on Earth.",
    },
    {
        "species": "Gray Whale",
        "fact": "Gray whales make one of the longest migrations of any mammal, traveling about 12,000 miles round trip each year.",
    },
    {
        "species": "Orca",
        "fact": "Orcas (killer whales) live in tight-knit family groups called pods and have unique dialects that are passed down through generations.",
    },
]


def show_random_fact():
    """Display a random whale fact."""
    entry = random.choice(WHALE_FACTS)
    print(f"\n  [{entry['species']}]")
    print(f"  {entry['fact']}\n")


def show_all_species():
    """List all whale species in the database."""
    species = sorted(set(entry["species"] for entry in WHALE_FACTS))
    print("\n  Whale species in the database:")
    for s in species:
        count = sum(1 for e in WHALE_FACTS if e["species"] == s)
        print(f"    - {s} ({count} fact{'s' if count > 1 else ''})")
    print()


def quiz():
    """Run a quick quiz matching facts to species."""
    entry = random.choice(WHALE_FACTS)
    species_list = sorted(set(e["species"] for e in WHALE_FACTS))

    print(f"\n  Which whale does this describe?\n")
    print(f'  "{entry["fact"]}"\n')

    # Build answer choices: correct + 3 random others
    wrong = [s for s in species_list if s != entry["species"]]
    choices = [entry["species"]] + random.sample(wrong, min(3, len(wrong)))
    random.shuffle(choices)

    for i, choice in enumerate(choices, 1):
        print(f"    {i}. {choice}")
    print()

    try:
        answer = input("  Your answer (number): ").strip()
        idx = int(answer) - 1
        if choices[idx] == entry["species"]:
            print("  Correct! Nice work!\n")
        else:
            print(f"  Not quite — it was the {entry['species']}!\n")
    except (ValueError, IndexError):
        print(f"  Invalid choice. The answer was: {entry['species']}\n")


def main():
    print("\n  ~ Welcome to Whale Facts! ~")

    while True:
        print("  What would you like to do?")
        print("    1. Get a random whale fact")
        print("    2. See all whale species")
        print("    3. Take a quiz")
        print("    4. Quit")

        choice = input("\n  Choose (1-4): ").strip()

        if choice == "1":
            show_random_fact()
        elif choice == "2":
            show_all_species()
        elif choice == "3":
            quiz()
        elif choice == "4":
            print("\n  Thanks for learning about whales! Bye!\n")
            break
        else:
            print("\n  Please pick 1, 2, 3, or 4.\n")


if __name__ == "__main__":
    main()
