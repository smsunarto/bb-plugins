// Package semver classifies version bumps the way Dependencies shows them:
// major, minor, patch or pre-release, from two semver strings.
package semver

import (
	"strconv"
	"strings"
)

// Version is a parsed semver version.
type Version struct {
	Major, Minor, Patch int
	Pre                 string
}

// Parse reads "1.2.3", "v1.2.3" or "1.2.3-rc.1"; ok is false for anything else.
func Parse(text string) (Version, bool) {
	text = strings.TrimPrefix(strings.TrimSpace(text), "v")
	core, pre, _ := strings.Cut(text, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return Version{}, false
	}
	numbers := make([]int, 3)
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return Version{}, false
		}
		numbers[i] = n
	}
	return Version{numbers[0], numbers[1], numbers[2], pre}, true
}

// Bump names the change from current to latest: "major", "minor", "patch",
// "pre-release", "same", or "unknown" when either side is not semver.
func Bump(current, latest string) string {
	from, ok := Parse(current)
	if !ok {
		return "unknown"
	}
	to, ok := Parse(latest)
	if !ok {
		return "unknown"
	}
	switch {
	case to.Major != from.Major:
		return "major"
	case to.Minor != from.Minor:
		return "minor"
	case to.Patch != from.Patch:
		return "patch"
	case to.Pre != from.Pre:
		return "pre-release"
	}
	return "same"
}

// Changed is the part of latest that differs from current, for emphasis:
// "4.0.0" against "3.9.1" is "4.0.0", "3.10.0" against "3.9.1" is "10.0".
func Changed(current, latest string) string {
	switch Bump(current, latest) {
	case "major":
		return strings.TrimPrefix(latest, "v")
	case "minor":
		_, rest, _ := strings.Cut(strings.TrimPrefix(latest, "v"), ".")
		return rest
	case "patch":
		parts := strings.SplitN(strings.TrimPrefix(latest, "v"), ".", 3)
		return parts[2]
	}
	return ""
}
