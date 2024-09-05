package hello

import (
	"errors"
	"fmt"
)

// Hello returns a greeting for the named person.
func Hello(name string) (string, error) {
	// If no name was given, return an error with a message.
	if name == "" {
		return name, errors.New("empty name test")
	}
	message := fmt.Sprintf("Hello %s test", name)
	return message, nil
}
