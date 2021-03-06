/** 
 *    You are given a 2D array of numbers (array of array of numbers) that represents a
 * triangle (the first array has one element, and each array has one more element than
 * the one before it, forming a triangle). Find the minimum path sum from the top to the
 * bottom of the triangle. In each step of the path, you may only move to adjacent
 * numbers in the row below.
 * 
 * @param {import("../../..").NS } ns */
export function triangle(ns, input) {
    let triangle = input;
    let nextArray;
    let previousArray = triangle[0];
   
    for (let i = 1; i < triangle.length; i++) {
        nextArray = [];
        for (let j = 0; j < triangle[i].length; j++) {
            if (j == 0) {
                nextArray.push(previousArray[j] + triangle[i][j]);
            } else if (j == triangle[i].length - 1) {
                nextArray.push(previousArray[j - 1] + triangle[i][j]);
            } else {
                nextArray.push(Math.min(previousArray[j], previousArray[j - 1]) + triangle[i][j]);
            }

        }

        previousArray = nextArray;
    }

    return Math.min.apply(null, nextArray);
}

/**
 * You are given an array with two numbers: [m, n]. These numbers represent an
 * m x n grid. Assume you are initially positioned in the top-left corner of that
 * grid and that you are trying to reach the bottom-right corner. On each step,
 * you may only move down or to the right.

 * Determine how many unique paths there are from start to finish
 *  @param {import("../../..").NS } ns */
export function grid(ns, data) {
    let width = data[0] - 1;
    let height = data[1] - 1;

    if (width > height) { [width, height] = [height, width] }

    let n = width + height
    let paths = 1;

    for (var i = 1; i <= width; i++) {
        paths = paths * n / i;
        n--;
    }
    return paths;

}

/**
 * You are given a 2D array of numbers (array of array of numbers) representing
 * a grid. The 2D array contains 1’s and 0’s, where 1 represents an obstacle and
 * 0 represents a free space.
 * 
 * Assume you are initially positioned in top-left corner of that grid and that you
 * are trying to reach the bottom-right corner. In each step, you may only move down
 * or to the right. Furthermore, you cannot move onto spaces which have obstacles.
 * 
 * Determine how many unique paths there are from start to finish.
 *  @param {import("../../..").NS } ns */
export function gridWithObstacles(ns, data) {
    var maxY = data.length;
    var maxX = data[0].length;
    var c = Array(maxY);
    for (var y = 0; y < maxY; y++) {
        var row = data[y];
        c[y] = Array(maxX);
        for (var x = 0; x < row.length; x++) {
            var s = 0;
            if (row[x] == 0) {
                if (x == 0 && y == 0) {
                    s = 1;
                }
                if (y > 0) {
                    s += c[y - 1][x];
                }
                if (x > 0) {
                    s += c[y][x - 1];
                }
            }
            c[y][x] = s;
        }
    }
    return c[maxY - 1][maxX - 1];
}