// Prints the newest release tag.
package main

import (
	"fmt"
	"sort"
)

type release struct {
	tag   string
	parts []int
}

func newest(releases []release) release {
	sort.Slice(releases, func(i, j int) bool {
		return releases[i].parts[2] > releases[j].parts[2]
	})
	return releases[0]
}

func main() {
	releases := []release{
		{"v1.4.2", []int{1, 4, 2}},
		{"v1.5", []int{1, 5}},
	}
	fmt.Println(newest(releases).tag)
}
